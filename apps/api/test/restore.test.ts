import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { projectRoot } from '../src/paths.js';
import { legacyDatabase, withoutFairId } from './legacy-database.js';

const tables = ['owners','products','sales','sale_items','days','stock_adjustments'];
const rows = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const restore = (source: string, target: string) => spawnSync(process.execPath, [join(projectRoot, 'scripts/restaurar-backup.mjs'), source, target], { encoding: 'utf8' });

for (const version of [1, 2, 3,4] as const) test(`restaurador conserva backup e todos os registros (v${version} em WAL)`, () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-restauracao-'));
  let original: Database.Database | undefined, restored: Database.Database | undefined;
  try {
    original = openDatabase(join(folder, 'original.sqlite'));
    const register = new CashRegister(original);
    original.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante de teste');
    const product = register.saveProduct({ name: 'Produto de teste', description: '', ownerId: 1, priceCents: 1500, stock: 5, active: true });
    const sale = register.createSale({ requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Pix', status: 'Pago', note: '',
      items: [{ productId: product.id, quantity: 2, expectedPriceCents: 1500, discountCents: 0, feeCents: 0 }] });
    register.closeDay('2026-10-10', { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' });
    if (version === 4) {
      register.saveFair({name:'Feira encerrada com meta',targetCents:50000});
      register.closeFair('2026-10-10');
      const next=register.createFair({name:'Feira seguinte',targetCents:null,startDate:'2026-10-10'});
      const active=new CashRegister(original,next.id);
      active.createSale({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Dinheiro',status:'Pago',note:'Segunda feira, mesmo dia',
        items:[{productId:product.id,quantity:1,expectedPriceCents:1500,discountCents:0,feeCents:0}]});
      active.closeDay('2026-10-10',{openingCents:0,extraCents:0,withdrawalCents:0,countedCents:1500,note:'Outro fechamento'});
    }
    if (version >= 3) original.prepare('INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,source_sha256,imported_at,fair_id) VALUES(?,?,?,?,?,?,1)')
      .run('caixa-da-feira-ods', 'Vendas:6', 'hash da linha original', sale.id, 'sha original', new Date().toISOString());
    if (version < 4) legacyDatabase(original,version);
    const expectedRecords = version >= 3 ? original.prepare('SELECT * FROM spreadsheet_records').all() : [];
    const expectedFairs = version === 4 ? original.prepare('SELECT * FROM fairs').all() : null;
    const expected = rows(original), backup = join(folder, 'backup.sqlite'), target = join(folder, 'restaurado.sqlite');
    writeFileSync(backup, original.serialize());
    const before = hash(backup), result = restore(backup, target);
    assert.equal(result.status, 0, result.stderr);
    restored = new Database(target, { readonly: true });
    assert.equal(restored.pragma('user_version', { simple: true }), 4);
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    const actual = rows(restored);
    if (version < 4) for (let i=0;i<actual.length;i++) actual[i]=withoutFairId(actual[i]);
    if (version === 1) actual[1] = actual[1].map(({ version, ...row }) => { assert.equal(version, 1); return row; });
    assert.deepEqual(actual, expected);
    const restoredRecords = restored.prepare('SELECT * FROM spreadsheet_records').all() as Record<string,unknown>[];
    assert.deepEqual(version < 4 ? withoutFairId(restoredRecords) : restoredRecords, expectedRecords);
    if (expectedFairs) assert.deepEqual(restored.prepare('SELECT * FROM fairs').all(),expectedFairs);
    const bootstrap = new CashRegister(restored,1).bootstrap('2026-10-10');
    assert.equal(bootstrap.day.summary.netCents, 3000);
    assert.ok(bootstrap.day.closedAt); assert.equal(bootstrap.products[0].stock, version===4 ? 2 : 3);
    assert.equal(hash(backup), before);
    restored.close(); restored = undefined;
    const targetBefore = hash(target), repeated = restore(backup, target);
    assert.equal(repeated.status, 1); assert.match(repeated.stderr, /destino já existe/);
    assert.equal(hash(target), targetBefore); assert.equal(hash(backup), before);
  } finally {
    if (restored?.open) restored.close(); if (original?.open) original.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('restaurador recusa arquivo inválido, versão futura e esquema de outro programa sem criar destino', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-backup-invalido-'));
  try {
    const text = join(folder, 'texto.sqlite'); writeFileSync(text, 'arquivo que não é SQLite');
    const future = join(folder, 'future.sqlite'), futureDb = new Database(future);
    futureDb.pragma('user_version = 5'); futureDb.close();
    const foreign = join(folder, 'foreign.sqlite'), foreignDb = new Database(foreign);
    foreignDb.exec('CREATE TABLE qualquer(id INTEGER); PRAGMA user_version = 2'); foreignDb.close();
    for (const [source, message] of [[text, /não é um banco SQLite/], [future, /incompatível/], [foreign, /esquema esperado/]] as const) {
      const before = hash(source), target = join(folder, 'nao-criar.sqlite'), result = restore(source, target);
      assert.equal(result.status, 1); assert.match(result.stderr, message);
      assert.equal(existsSync(target), false); assert.equal(hash(source), before);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('restaurador recusa auxiliares residuais sem arquivo principal e preserva um WAL real', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-wal-residual-'));
  let backupDb: Database.Database | undefined, oldDb: Database.Database | undefined;
  try {
    backupDb = openDatabase(':memory:');
    const backup = join(folder, 'backup.sqlite'); writeFileSync(backup, backupDb.serialize());
    const target = join(folder, 'destino.sqlite'), captured = join(folder, 'wal-capturado');
    oldDb = openDatabase(target);
    oldDb.pragma('wal_autocheckpoint = 0');
    const register = new CashRegister(oldDb);
    oldDb.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante do WAL antigo');
    const product = register.saveProduct({ name: 'Produto antigo', description: '', ownerId: 1, priceCents: 1500, stock: 5, active: true });
    register.createSale({ requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Pix', status: 'Pago', note: 'PEDIDO DO WAL ANTIGO',
      items: [{ productId: product.id, quantity: 1, expectedPriceCents: 1500, discountCents: 0, feeCents: 0 }] });
    copyFileSync(`${target}-wal`, captured);
    oldDb.close(); oldDb = undefined; rmSync(target);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const auxiliary = `${target}${suffix}`;
      if (suffix === '-wal') copyFileSync(captured, auxiliary);
      else writeFileSync(auxiliary, 'arquivo auxiliar anterior');
      const before = hash(auxiliary), backupBefore = hash(backup), result = restore(backup, target);
      assert.equal(result.status, 1); assert.match(result.stderr, /arquivos auxiliares/);
      assert.equal(existsSync(target), false); assert.equal(hash(auxiliary), before);
      assert.equal(hash(backup), backupBefore);
      rmSync(auxiliary);
    }
  } finally {
    if (oldDb?.open) oldDb.close(); if (backupDb?.open) backupDb.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
