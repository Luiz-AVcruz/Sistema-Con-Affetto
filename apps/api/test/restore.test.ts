import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, symlinkSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase, schemaVersion } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { projectRoot } from '../src/paths.js';
import { legacyDatabase, withoutFairId, withoutDeletedAt } from './legacy-database.js';

const tables = ['owners','products','sales','sale_items','days','stock_adjustments'];
const rows = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]);
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const restore = (source: string, target: string) => spawnSync(process.execPath, [join(projectRoot, 'scripts/restaurar-backup.mjs'), source, target], { encoding: 'utf8' });

for (const version of [1, 2, 3, 4, 5] as const) test(`restaurador conserva backup e todos os registros (v${version} em WAL)`, () => {
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
    if (version >= 4) {
      register.saveFair({name:'Feira encerrada com meta',targetCents:50000});
      register.closeFair('2026-10-10');
      const next=register.createFair({name:'Feira seguinte',targetCents:null,startDate:'2026-10-10'});
      const active=new CashRegister(original,next.id);
      if (version === 5) {
        const accidental = active.createSale({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Pix',status:'Pago',note:'Excluído antes do fechamento',
          items:[{productId:product.id,quantity:1,expectedPriceCents:1500,discountCents:0,feeCents:0}]});
        active.deleteSale(accidental.id);
      }
      active.createSale({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Dinheiro',status:'Pago',note:'Segunda feira, mesmo dia',
        items:[{productId:product.id,quantity:1,expectedPriceCents:1500,discountCents:0,feeCents:0}]});
      active.closeDay('2026-10-10',{openingCents:0,extraCents:0,withdrawalCents:0,countedCents:1500,note:'Outro fechamento'});
    }
    if (version >= 3) original.prepare('INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,source_sha256,imported_at,fair_id) VALUES(?,?,?,?,?,?,1)')
      .run('caixa-da-feira-ods', 'Vendas:6', 'hash da linha original', sale.id, 'sha original', new Date().toISOString());
    if (version < 4) legacyDatabase(original,version);
    if (version === 4) original.exec('ALTER TABLE sales DROP COLUMN deleted_at; PRAGMA user_version = 4');
    const expectedRecords = version >= 3 ? original.prepare('SELECT * FROM spreadsheet_records').all() : [];
    const expectedFairs = version >= 4 ? original.prepare('SELECT * FROM fairs').all() : null;
    const expected = rows(original), backup = join(folder, 'backup.sqlite'), target = join(folder, 'restaurado.sqlite');
    writeFileSync(backup, original.serialize());
    const before = hash(backup), result = restore(backup, target);
    assert.equal(result.status, 0, result.stderr);
    restored = new Database(target, { readonly: true });
    assert.equal(restored.pragma('user_version', { simple: true }), schemaVersion);
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    const actual = rows(restored);
    if (version < 5) for (let i=0;i<actual.length;i++) actual[i]=withoutDeletedAt(actual[i]);
    if (version < 4) for (let i=0;i<actual.length;i++) actual[i]=withoutFairId(actual[i]);
    if (version === 1) actual[1] = actual[1].map(({ version, ...row }) => { assert.equal(version, 1); return row; });
    assert.deepEqual(actual, expected);
    const restoredRecords = restored.prepare('SELECT * FROM spreadsheet_records').all() as Record<string,unknown>[];
    assert.deepEqual(version < 4 ? withoutFairId(restoredRecords) : restoredRecords, expectedRecords);
    if (expectedFairs) assert.deepEqual(restored.prepare('SELECT * FROM fairs').all(),expectedFairs);
    const bootstrap = new CashRegister(restored,1).bootstrap('2026-10-10');
    assert.equal(bootstrap.day.summary.netCents, 3000);
    assert.ok(bootstrap.day.closedAt); assert.equal(bootstrap.products[0].stock, version>=4 ? 2 : 3);
    if (version === 5) {
      const deleted = restored.prepare('SELECT id FROM sales WHERE deleted_at IS NOT NULL').get() as { id: string };
      assert.ok(deleted);
      assert.equal(new CashRegister(restored).sales().some(sale => sale.id === deleted.id),false);
      assert.equal(new CashRegister(restored).summary().netCents,1500);
    }
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
    futureDb.pragma(`user_version = ${schemaVersion + 1}`); futureDb.close();
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

test('restaurador recusa destino e auxiliares que sejam links simbólicos quebrados', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-restauracao-links-'));
  const db = openDatabase(':memory:');
  try {
    const backup = join(folder, 'backup.sqlite'), target = join(folder, 'destino.sqlite');
    writeFileSync(backup, db.serialize());
    const before = hash(backup);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = `${target}${suffix}`, missing = join(folder, 'ausente.sqlite');
      symlinkSync(missing, path);
      const result = restore(backup, target);
      assert.equal(result.status, 1); assert.match(result.stderr, /destino já existe/);
      assert.equal(lstatSync(path).isSymbolicLink(), true);
      assert.equal(readlinkSync(path), missing); assert.equal(hash(backup), before);
      assert.equal(existsSync(target), false);
      rmSync(path);
    }
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

for (const failure of ['erro', 'interrupcao'] as const) test(`restauração com ${failure} durante a cópia não publica destino parcial e permite repetir`, () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-restauracao-falha-'));
  const db = openDatabase(':memory:');
  let restored: Database.Database | undefined;
  try {
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante de teste preservado');
    const backup = join(folder, 'backup.sqlite'), target = join(folder, 'destino.sqlite'), preload = join(folder, 'falha.mjs');
    writeFileSync(backup, db.serialize());
    const before = hash(backup);
    // A dependência deixa bytes parciais e falha durante a cópia de publicação.
    // SIGKILL desafia o caso em que catch/finally não podem executar a limpeza.
    writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const copy = fs.copyFileSync; let copies = 0;
fs.copyFileSync = (...args) => {
  if (++copies !== 2) return copy(...args);
  fs.writeFileSync(args[1], 'arquivo incompleto');
  if (process.env.CAIXA_TEST_COPY_FAILURE === 'interrupcao') process.kill(process.pid, 'SIGKILL');
  throw new Error('Falha de I/O durante a cópia de teste');
};
syncBuiltinESMExports();`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
      join(projectRoot, 'scripts/restaurar-backup.mjs'), backup, target], {
      encoding: 'utf8', env: { ...process.env, CAIXA_TEST_COPY_FAILURE: failure }
    });
    if (failure === 'interrupcao') assert.equal(result.signal, 'SIGKILL');
    else { assert.equal(result.status, 1); assert.match(result.stderr, /Falha de I\/O/); }
    assert.equal(existsSync(target), false, 'nenhum arquivo parcial no caminho final');
    const residues = () => readdirSync(folder).filter(name => name.startsWith('.caixa-restauracao-'));
    assert.equal(residues().length, failure === 'interrupcao' ? 1 : 0, 'resíduo abrupto é explícito e não bloqueia o destino');
    assert.equal(hash(backup), before);
    const retry = restore(backup, target);
    assert.equal(retry.status, 0, retry.stderr);
    restored = new Database(target, { readonly: true });
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(restored.pragma('foreign_key_check'), []);
    assert.equal((restored.prepare('SELECT name FROM owners WHERE id=1').get() as {name: string}).name, 'Participante de teste preservado');
    assert.equal(hash(backup), before);
    assert.equal(residues().length, failure === 'interrupcao' ? 1 : 0, 'retry não deixa novo resíduo');
  } finally { restored?.close(); db.close(); rmSync(folder, { recursive: true, force: true }); }
});
