import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../apps/api/dist/database.js';
import { CashRegister } from '../apps/api/dist/cash-register.js';

const [source, fairIdText, mode] = process.argv.slice(2);
if (!source || !/^[1-9][0-9]*$/.test(fairIdText ?? '') || mode !== undefined && mode !== '--apply') {
  console.error('Uso: node scripts/corrigir-taxas-cartao.mjs banco.sqlite feira-id [--apply]'); process.exit(1);
}
const path = resolve(source), fairId = Number(fairIdText), applying = mode === '--apply';
const folder = mkdtempSync(join(tmpdir(), 'caixa-taxas-'));
let db, backup;
try {
  db = new Database(path, { readonly: true, fileMustExist: true });
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Falha de integridade no banco de origem.');
  const bytes = db.serialize(); db.close(); db = undefined;
  if (applying) {
    const backups = join(dirname(path), 'backups'); mkdirSync(backups, { recursive: true });
    backup = join(backups, 'antes-taxas-' + new Date().toISOString().replaceAll(':', '-') + '.sqlite');
    writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600, flush: true });
  } else writeFileSync(join(folder, 'simulacao.sqlite'), bytes);
  db = openDatabase(applying ? path : join(folder, 'simulacao.sqlite'));
  const register = new CashRegister(db, fairId);
  const result = register.correctPastCardFees('Taxas Mercado Pago por aproximação confirmadas pela operadora. Retificação preservando os registros e fechamentos originais.');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) throw new Error('Falha de integridade após a retificação. Conserve o backup.');
  console.log(JSON.stringify({ mode: applying ? 'aplicado' : 'simulacao', fairId, backup: backup ?? null, ...result,
    summary: register.summary() }, null, 2));
} catch (error) {
  console.error(error.message);
  if (backup) console.error('Backup anterior preservado em: ' + backup);
  process.exitCode = 1;
} finally {
  if (db?.open) db.close();
  rmSync(folder, { recursive: true, force: true });
}
