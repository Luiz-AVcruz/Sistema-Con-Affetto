import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const schemaVersion = 7;

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > schemaVersion) { db.close(); throw new Error('Banco de uma versão mais nova. Não foi modificado.'); }
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (version === 0) db.transaction(() => {
      db.exec(`
      CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE products (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        owner_id INTEGER NOT NULL REFERENCES owners(id), price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
        stock INTEGER CHECK(stock IS NULL OR stock >= 0), active INTEGER NOT NULL CHECK(active IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sales (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, date TEXT NOT NULL, payment_date TEXT,
        payment_method TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Pago','Pendente','Cancelado')),
        note TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE sale_items (
        id INTEGER PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id),
        product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL,
        owner_id INTEGER NOT NULL REFERENCES owners(id), owner_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0), price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
        discount_cents INTEGER NOT NULL CHECK(discount_cents >= 0), fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0),
        gross_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL, net_cents INTEGER NOT NULL
      );
      CREATE TABLE days (
        date TEXT PRIMARY KEY, opening_cents INTEGER NOT NULL, extra_cents INTEGER NOT NULL,
        withdrawal_cents INTEGER NOT NULL, counted_cents INTEGER, note TEXT NOT NULL,
        closed_at TEXT, snapshot TEXT
      );
      CREATE TABLE stock_adjustments (
        id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
        before_stock INTEGER, after_stock INTEGER, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX sales_payment_date ON sales(payment_date);
      CREATE INDEX sale_items_sale ON sale_items(sale_id);
      PRAGMA user_version = 2;
      `);
    })();
    if (version === 1) db.transaction(() => {
      // O primeiro protótipo v1 existiu com e sem a proteção de edição.
      const columns = db.pragma('table_info(products)') as { name: string }[];
      if (!columns.some(column => column.name === 'version')) {
        db.exec('ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
      }
      db.pragma('user_version = 2');
    })();
    if (version < 3) db.transaction(() => {
      db.exec(`CREATE TABLE spreadsheet_records (
        source_key TEXT NOT NULL, record_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        sale_id TEXT REFERENCES sales(id), day_date TEXT UNIQUE REFERENCES days(date),
        source_sha256 TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(source_key, record_key),
        CHECK((sale_id IS NULL) <> (day_date IS NULL))
      ); PRAGMA user_version = 3;`);
    })();
    if (version < 4) {
      // A troca da chave de days exige reconstruir também seu vínculo de origem.
      // SQLite só permite mudar foreign_keys fora da transação.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`CREATE TABLE fairs (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, target_cents INTEGER CHECK(target_cents IS NULL OR target_cents > 0),
            start_date TEXT NOT NULL, end_date TEXT, created_at TEXT NOT NULL, closed_at TEXT, snapshot TEXT
          );
          CREATE UNIQUE INDEX one_active_fair ON fairs((1)) WHERE closed_at IS NULL;`);
          const firstDate = (db.prepare('SELECT MIN(date) AS date FROM (SELECT date FROM sales UNION ALL SELECT date FROM days)').get() as { date: string | null }).date;
          const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
          db.prepare('INSERT INTO fairs(id,name,start_date,created_at) VALUES(1,?,?,?)').run('Feira atual', firstDate ?? today, new Date().toISOString());
          db.exec(`ALTER TABLE sales ADD COLUMN fair_id INTEGER NOT NULL DEFAULT 1 REFERENCES fairs(id);
          CREATE INDEX sales_fair_date ON sales(fair_id,date);
          CREATE TABLE days_v4 (
            fair_id INTEGER NOT NULL REFERENCES fairs(id), date TEXT NOT NULL,
            opening_cents INTEGER NOT NULL, extra_cents INTEGER NOT NULL, withdrawal_cents INTEGER NOT NULL,
            counted_cents INTEGER, note TEXT NOT NULL, closed_at TEXT, snapshot TEXT,
            PRIMARY KEY(fair_id,date)
          );
          INSERT INTO days_v4 SELECT 1,date,opening_cents,extra_cents,withdrawal_cents,counted_cents,note,closed_at,snapshot FROM days;
          DROP TABLE days;
          ALTER TABLE days_v4 RENAME TO days;
          CREATE TABLE spreadsheet_records_v4 (
            source_key TEXT NOT NULL, record_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
            sale_id TEXT REFERENCES sales(id), day_date TEXT, source_sha256 TEXT NOT NULL, imported_at TEXT NOT NULL,
            fair_id INTEGER NOT NULL REFERENCES fairs(id), PRIMARY KEY(source_key,record_key),
            UNIQUE(fair_id,day_date), FOREIGN KEY(fair_id,day_date) REFERENCES days(fair_id,date),
            CHECK((sale_id IS NULL) <> (day_date IS NULL))
          );
          INSERT INTO spreadsheet_records_v4 SELECT source_key,record_key,payload_hash,sale_id,day_date,source_sha256,imported_at,1 FROM spreadsheet_records;
          DROP TABLE spreadsheet_records;
          ALTER TABLE spreadsheet_records_v4 RENAME TO spreadsheet_records;`);
          if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('A migração encontrou referências inconsistentes. Nada foi migrado para v4.');
          db.pragma('user_version = 4');
        }).immediate();
      } finally { db.pragma('foreign_keys = ON'); }
    }
    if (version < 5) db.transaction(() => {
      // O marcador mantém a chave de reenvio e os vínculos da importação.
      // Nenhum pedido existente é excluído durante a migração.
      db.exec('ALTER TABLE sales ADD COLUMN deleted_at TEXT; PRAGMA user_version = 5;');
    }).immediate();
    if (version < 6) db.transaction(() => {
      db.exec(`ALTER TABLE sales ADD COLUMN automatic_fees INTEGER NOT NULL DEFAULT 0 CHECK(automatic_fees IN (0,1));
        ALTER TABLE sales ADD COLUMN card_entry TEXT CHECK(card_entry IS NULL OR card_entry IN ('Aproximação','Inserido'));
        CREATE TABLE payment_fee_corrections (
          id INTEGER PRIMARY KEY, sale_item_id INTEGER NOT NULL UNIQUE REFERENCES sale_items(id),
          previous_fee_cents INTEGER NOT NULL CHECK(previous_fee_cents >= 0),
          corrected_fee_cents INTEGER NOT NULL CHECK(corrected_fee_cents >= 0),
          card_entry TEXT NOT NULL CHECK(card_entry IN ('Aproximação','Inserido')),
          reason TEXT NOT NULL, created_at TEXT NOT NULL
        ); PRAGMA user_version = 6;`);
    }).immediate();
    if (version < 7) db.transaction(() => {
      // Somente vendas novas com dois pagamentos usam esta tabela. Não há
      // backfill nem reescrita de hashes, itens, taxas ou snapshots anteriores.
      db.exec(`CREATE TABLE sale_payments (
        id INTEGER PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id),
        position INTEGER NOT NULL CHECK(position IN (0,1)),
        payment_method TEXT NOT NULL CHECK(payment_method IN ('Dinheiro','Pix','Cartão débito','Cartão crédito')),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0 AND fee_cents <= amount_cents),
        card_entry TEXT CHECK(card_entry IS NULL OR card_entry IN ('Aproximação','Inserido')),
        CHECK((payment_method IN ('Cartão débito','Cartão crédito') AND card_entry IS NOT NULL)
          OR (payment_method IN ('Dinheiro','Pix') AND card_entry IS NULL)),
        UNIQUE(sale_id,position)
      ); PRAGMA user_version = 7;`);
    }).immediate();
    return db;
  } catch (error) { db.close(); throw error; }
}
