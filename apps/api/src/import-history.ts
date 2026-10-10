import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import { databasePath, projectRoot } from './paths.js';
import { historySchema, importHistory } from './historical-import.js';

// Pare o aplicativo antes deste comando. O backup inclui transações ainda no WAL.
const source = process.argv[2] ?? resolve(projectRoot, 'data/historico-planilha.json');
const input = historySchema.parse(JSON.parse(readFileSync(source, 'utf8')));
if (!existsSync(databasePath)) throw new Error('Banco inexistente. Importe o catálogo primeiro.');
const folder = join(dirname(databasePath), 'backups');
mkdirSync(folder, { recursive: true });
const backupPath = join(folder, `antes-historico-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
const original = new Database(databasePath, { readonly: true, fileMustExist: true });
try { writeFileSync(backupPath, original.serialize(), { flag: 'wx' }); } finally { original.close(); }
console.log(`Backup anterior: ${backupPath}`);
const db = openDatabase(databasePath);
try {
  const result = importHistory(db, input);
  console.log(result.alreadyImported ? 'Histórico já importado; pedidos, fechamentos e estoque preservados.' :
    `${result.importedRows} linhas em ${result.importedOrders} pedidos e ${result.importedClosedDays} fechamentos importados. Estoque preservado.`);
} finally { db.close(); }
