import type Database from 'better-sqlite3';

// Produz as estruturas efetivamente publicadas; mudar só user_version não prova migração.
export function legacyDatabase(db: Database.Database, version: 1 | 2 | 3, keepVersion = version !== 1): void {
  legacyPaymentColumns(db);
  const records = db.prepare('SELECT * FROM spreadsheet_records').all() as Record<string, unknown>[];
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`ALTER TABLE sales DROP COLUMN deleted_at;
        DROP TABLE spreadsheet_records;
        CREATE TABLE days_old(date TEXT PRIMARY KEY,opening_cents INTEGER NOT NULL,extra_cents INTEGER NOT NULL,
          withdrawal_cents INTEGER NOT NULL,counted_cents INTEGER,note TEXT NOT NULL,closed_at TEXT,snapshot TEXT);
        INSERT INTO days_old SELECT date,opening_cents,extra_cents,withdrawal_cents,counted_cents,note,closed_at,snapshot FROM days;
        DROP TABLE days; ALTER TABLE days_old RENAME TO days;
        DROP INDEX sales_fair_date; ALTER TABLE sales DROP COLUMN fair_id; DROP TABLE fairs;`);
      if (version === 3) {
        db.exec(`CREATE TABLE spreadsheet_records(source_key TEXT NOT NULL,record_key TEXT NOT NULL,payload_hash TEXT NOT NULL,
          sale_id TEXT REFERENCES sales(id),day_date TEXT UNIQUE REFERENCES days(date),source_sha256 TEXT NOT NULL,
          imported_at TEXT NOT NULL,PRIMARY KEY(source_key,record_key),CHECK((sale_id IS NULL) <> (day_date IS NULL)));`);
        const insert = db.prepare('INSERT INTO spreadsheet_records VALUES(?,?,?,?,?,?,?)');
        for (const row of records) insert.run(row.source_key,row.record_key,row.payload_hash,row.sale_id,row.day_date,row.source_sha256,row.imported_at);
      }
      if (!keepVersion) db.exec('ALTER TABLE products DROP COLUMN version');
      db.pragma(`user_version = ${version}`);
    })();
  } finally { db.pragma('foreign_keys = ON'); }
}

export function legacyPaymentColumns(db: Database.Database): void {
  db.exec('DROP TABLE payment_fee_corrections; ALTER TABLE sales DROP COLUMN automatic_fees; ALTER TABLE sales DROP COLUMN card_entry; PRAGMA user_version = 5;');
}

export function withoutPaymentColumns(rows: Record<string, unknown>[]) {
  return rows.map(({ automatic_fees, card_entry, ...row }) => {
    if (automatic_fees !== undefined && automatic_fees !== 0 || card_entry !== undefined && card_entry !== null) throw new Error('A migração alterou o pagamento existente.');
    return row;
  });
}

export function withoutFairId(rows: Record<string, unknown>[]) {
  return withoutPaymentColumns(withoutDeletedAt(rows)).map(({ fair_id, ...row }) => { if (fair_id !== undefined) {
    if (fair_id !== 1) throw new Error('Registro antigo associado à feira incorreta.');
  } return row; });
}

export function withoutDeletedAt(rows: Record<string, unknown>[]) {
  return rows.map(({ deleted_at, ...row }) => {
    if (deleted_at !== undefined && deleted_at !== null) throw new Error('A migração excluiu um pedido existente.');
    return row;
  });
}
