import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import { databasePath, projectRoot } from './paths.js';
import { historySchema, importHistory } from './historical-import.js';

// Pare o aplicativo antes deste comando. O backup inclui transações ainda no WAL.
const args = process.argv.slice(2);
const source = args.find(arg => !arg.startsWith('--')) ?? resolve(projectRoot, 'data/historico-planilha.json');
if (args.some(arg => arg.startsWith('--') && arg !== '--reconcile-stock')) throw new Error('Opção desconhecida. Use somente --reconcile-stock para conciliar o saldo salvo.');
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
  const result = importHistory(db, input, { reconcileStock: args.includes('--reconcile-stock') });
  console.log(result.alreadyImported ? 'Histórico já importado; pedidos, fechamentos e estoque preservados.' :
    `${result.importedRows} linhas em ${result.importedOrders} pedidos e ${result.importedClosedDays} fechamentos importados. ${result.reconciledProducts} saldos conciliados; saídas históricas não foram baixadas novamente.`);
} finally { db.close(); }
