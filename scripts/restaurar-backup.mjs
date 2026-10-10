import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, schemaVersion } from '../apps/api/dist/database.js';

const requiredColumns = {
  owners: ['id', 'name'],
  products: ['id', 'name', 'description', 'owner_id', 'price_cents', 'stock', 'active'],
  sales: ['id', 'request_hash', 'date', 'payment_date', 'payment_method', 'status', 'note', 'created_at'],
  sale_items: ['id', 'sale_id', 'product_id', 'name', 'owner_id', 'owner_name', 'quantity', 'price_cents', 'discount_cents', 'fee_cents', 'gross_cents', 'total_cents', 'net_cents'],
  days: ['date', 'opening_cents', 'extra_cents', 'withdrawal_cents', 'counted_cents', 'note', 'closed_at', 'snapshot'],
  stock_adjustments: ['id', 'product_id', 'before_stock', 'after_stock', 'reason', 'created_at']
};

const [source, destination] = process.argv.slice(2);
if (!source || !destination) { console.error('Uso: node scripts/restaurar-backup.mjs backup.sqlite novo-destino.sqlite'); process.exit(1); }
const target = resolve(destination);
if ([target, `${target}-wal`, `${target}-shm`, `${target}-journal`].some(path => existsSync(path))) {
  console.error('O destino já existe ou possui arquivos auxiliares. Nada foi sobrescrito. Escolha outro arquivo.'); process.exit(1);
}
const folder = mkdtempSync(join(tmpdir(), 'caixa-restauracao-')), temporary = join(folder, 'backup.sqlite');
let db;
try {
  if (readFileSync(source).subarray(0,16).toString() !== 'SQLite format 3\0') throw new Error('O arquivo não é um banco SQLite.');
  // Abrir uma cópia em disco também respeita o cabeçalho WAL de backups reais.
  copyFileSync(source, temporary);
  db = new Database(temporary, { readonly: true, fileMustExist: true });
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup com falha de integridade.');
  const version = db.pragma('user_version', { simple: true });
  if (![1, 2, 3, schemaVersion].includes(version)) throw new Error('Versão do backup incompatível com este programa.');
  if (version >= 3) requiredColumns.spreadsheet_records = ['source_key','record_key','payload_hash','sale_id','day_date','source_sha256','imported_at'];
  if (version >= 4) {
    requiredColumns.fairs = ['id','name','target_cents','start_date','end_date','created_at','closed_at','snapshot'];
    for (const table of ['sales','days','spreadsheet_records']) requiredColumns[table].push('fair_id');
  }
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
    if (!required.every(column => columns.has(column)) || (version >= 2 && table === 'products' && !columns.has('version'))) {
      throw new Error(`O banco não contém o esquema esperado do caixa na tabela ${table}.`);
    }
  }
  if (db.pragma('foreign_key_check').length) throw new Error('O backup contém referências inconsistentes.');
  db.close(); db = undefined;
  // Migrar somente a cópia. A origem permanece disponível para recuperação.
  db = openDatabase(temporary);
  if (db.pragma('wal_checkpoint(TRUNCATE)').some(result => result.busy !== 0)) throw new Error('Não foi possível consolidar a cópia do banco.');
  db.close(); db = undefined;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(temporary, target, constants.COPYFILE_EXCL);
  console.log(`Cópia restaurada e validada: ${target}. O banco anterior foi preservado.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
