import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { importHistory, type HistoricalInput } from '../src/historical-import.js';
import { projectRoot } from '../src/paths.js';

function source(): HistoricalInput {
  const expected = { receivedCents: 5899, netCents: 5862, discountCents: 101, feeCents: 37,
    pendingCents: 1000, barterUnits: 1, giftUnits: 1,
    byOwner: { 'Participante A': 0, 'Participante B': 4000, 'Participante antigo': 1862 },
    byPayment: { 'Dinheiro': 0, 'Pix': 5899, 'Cartão débito': 0, 'Cartão crédito': 0 } };
  const row = { rowNumber: 6, orderRef: 'pedido misto', date: '2026-10-09', paymentMethod: 'Pix' as const,
    status: 'Pago' as const, note: 'Observação da primeira linha', name: 'Produto A', ownerName: 'Participante antigo',
    quantity: 2, priceCents: 1000, discountCents: 101, feeCents: 37, totalCents: 1899, netCents: 1862 };
  const ordinary = { ...row, orderRef: '', note: '', quantity: 1, discountCents: 0, feeCents: 0, totalCents: 1000, netCents: 1000 };
  return { formatVersion: 1, sourceKey: 'caixa-da-feira-ods', source: 'planilha de teste.ods', sha256: 'a'.repeat(64), lockPresent: false,
    products: [{ name: 'Produto A', stock: 10 }, { name: 'Produto B', stock: 3 }],
    rows: [row, { ...ordinary, rowNumber: 7, orderRef: 'pedido misto', name: 'Produto B', ownerName: 'Participante B', priceCents: 4000, totalCents: 4000, netCents: 4000, note: 'Observação da segunda linha' },
      { ...ordinary, rowNumber: 8, paymentMethod: 'Permuta', totalCents: 0, netCents: 0 },
      { ...ordinary, rowNumber: 9, date: '2026-10-10', name: 'Produto B', ownerName: 'Participante B', priceCents: 4000, paymentMethod: 'Não cobrado', totalCents: 0, netCents: 0 },
      { ...ordinary, rowNumber: 10, paymentMethod: 'Dinheiro', status: 'Pendente' },
      { ...ordinary, rowNumber: 11, date: '2026-10-10', paymentMethod: 'Dinheiro', status: 'Cancelado', totalCents: 0, netCents: 0 }], expected,
    closedDays: [{ date: '2026-10-09', cash: { openingCents: 1000, extraCents: 100, withdrawalCents: 200, countedCents: 0, note: 'Contagem zero' },
      expectedCents: 900, differenceCents: -900, expected: { ...expected, giftUnits: 0 } }] };
}
function fixture(path = ':memory:') {
  const db = openDatabase(path), register = new CashRegister(db);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?), (2,?)').run('Participante A', 'Participante B');
  const a = register.saveProduct({ name: 'Produto A', description: '', ownerId: 1, priceCents: 1500, stock: 10, active: true });
  register.saveProduct({ name: 'Produto B', description: '', ownerId: 2, priceCents: 4000, stock: 3, active: true });
  const input = { requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Cartão débito' as const, status: 'Pago' as const, note: 'Já registrado no app',
    items: [{ productId: a.id, quantity: 1, expectedPriceCents: a.priceCents, discountCents: 0, feeCents: 0 }] };
  const nativeSale = register.createSale(input);
  return { db, register, nativeSale, input };
}
const tables = ['owners', 'products', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records'];
const rows = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('importação preserva pedido nativo, estoque e versões; agrupa pedido misto e guarda preço/participante da linha', () => {
  const { db, register, nativeSale, input } = fixture();
  try {
    const catalog = register.products();
    const result = importHistory(db, source());
    assert.deepEqual(result, { importedOrders: 5, importedRows: 6, importedClosedDays: 1, alreadyImported: false });
    assert.deepEqual(register.products(), catalog);
    assert.deepEqual(register.sales().find(sale => sale.id === nativeSale.id), nativeSale);
    assert.deepEqual(register.createSale(input), nativeSale);
    const mixed = register.sales().find(sale => sale.items.length === 2)!;
    assert.equal(mixed.origin, 'Planilha'); assert.equal(mixed.totalCents, 5899); assert.equal(mixed.netCents, 5862);
    assert.equal(mixed.items[0].priceCents, 1000); assert.equal(mixed.items[0].ownerName, 'Participante antigo');
    assert.equal(mixed.note, 'Observação da primeira linha\nObservação da segunda linha');
    assert.equal(register.summary().netCents, 7362);
    const closed = register.day('2026-10-09');
    assert.ok(closed.closedAt); assert.equal(closed.summary.netCents, 5862); assert.equal(closed.summary.pendingCents, 1000);
    assert.equal(closed.countedCents, 0); assert.equal(closed.differenceCents, -900);
    assert.throws(() => register.cancelSale(mixed.id), /está fechado/);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('repetir a mesma origem preserva recebimento posterior, cancelamento e snapshot; SHA do arquivo não define identidade', () => {
  const { db, register } = fixture();
  try {
    const original = source(); importHistory(db, original);
    const closed = register.day('2026-10-09');
    const pending = register.sales().find(sale => sale.status === 'Pendente')!;
    register.receiveSale(pending.id, '2026-10-11', 'Pix');
    register.cancelSale(register.sales().find(sale => sale.paymentMethod === 'Não cobrado')!.id);
    const before = rows(db);
    const result = importHistory(db, { ...original, sha256: 'b'.repeat(64), source: 'outro-caminho.ods' });
    assert.equal(result.alreadyImported, true); assert.deepEqual(rows(db), before);
    assert.deepEqual(register.day('2026-10-09'), closed);
    const received = register.sales().find(sale => sale.id === pending.id)!;
    assert.equal(received.status, 'Pago'); assert.equal(received.paymentDate, '2026-10-11');
    assert.deepEqual(register.products().map(product => product.stock), [8, 4]);
  } finally { db.close(); }
});

test('origem editada, linha inserida ou removida após migração é recusada sem alterar registros', () => {
  const { db } = fixture();
  try {
    importHistory(db, source()); const before = rows(db);
    const edited = source(); edited.rows[1].note = 'alteração';
    const appended = source(); appended.rows.push({ ...appended.rows[1], rowNumber: 20 });
    const removed = source(); removed.rows.pop();
    for (const changed of [edited, appended, removed]) {
      assert.throws(() => importHistory(db, changed), /mudou desde a migração/); assert.deepEqual(rows(db), before);
    }
  } finally { db.close(); }
});

test('erro no último item ou no fechamento desfaz inclusive as linhas e participantes já inseridos', () => {
  const { db } = fixture();
  try {
    const before = rows(db), badRow = source(); badRow.rows[5].netCents = 1;
    const badClosing = source(); badClosing.closedDays[0].expected.byPayment.Pix = 5898;
    const badTotal = source(); badTotal.expected.netCents = 1;
    for (const changed of [badRow, badClosing, badTotal]) {
      assert.throws(() => importHistory(db, changed), /diverge|divergente/); assert.deepEqual(rows(db), before);
    }
  } finally { db.close(); }
});

test('saldo de origem divergente, vínculo ambíguo e dia já fechado impedem importação', () => {
  const { db, register } = fixture();
  try {
    const before = rows(db), mismatch = source(); mismatch.products[0].stock = 9;
    assert.throws(() => importHistory(db, mismatch), /Estoque/); assert.deepEqual(rows(db), before);
    register.saveProduct({ name: 'Produto A', description: '', ownerId: 1, priceCents: 1500, stock: 9, active: true });
    const ambiguous = rows(db); assert.throws(() => importHistory(db, source()), /ambíguo/); assert.deepEqual(rows(db), ambiguous);
    db.prepare('DELETE FROM products WHERE id=(SELECT MAX(id) FROM products)').run();
    register.closeDay('2026-10-09', { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' });
    const closed = rows(db); assert.throws(() => importHistory(db, source()), /já está fechado/); assert.deepEqual(rows(db), closed);
  } finally { db.close(); }
});

test('fechamento ODS é confrontado com pedidos nativos da mesma data; divergência desfaz a migração', () => {
  const { db, register, input } = fixture();
  try {
    register.createSale({ ...input, requestId: randomUUID(), date: '2026-10-09' });
    const before = rows(db);
    assert.throws(() => importHistory(db, source()), /Fechamento.*diverge/);
    assert.deepEqual(rows(db), before);
  } finally { db.close(); }
});

test('contagem manual registrada no app é considerada na conferência e permanece intacta', () => {
  const { db, register } = fixture();
  try {
    const product = register.products()[0]; register.saveProduct({ ...product, stock: 12, expectedVersion: product.version }, product.id);
    const before = register.products(), adjustments = db.prepare('SELECT * FROM stock_adjustments').all();
    importHistory(db, source()); assert.deepEqual(register.products(), before);
    assert.deepEqual(db.prepare('SELECT * FROM stock_adjustments').all(), adjustments);
  } finally { db.close(); }
});

test('CLI salva backup v2 antes de migrar e o histórico sobrevive ao reabrir o SQLite', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-importacao-cli-')), path = join(folder, 'caixa.sqlite');
  let db: Database.Database | undefined;
  try {
    const data = fixture(path); db = data.db;
    const before = rows(db).slice(0, -1); db.exec('DROP TABLE spreadsheet_records; PRAGMA user_version=2'); db.close(); db = undefined;
    const manifest = join(folder, 'historico.json'); writeFileSync(manifest, JSON.stringify(source()));
    const sourceBefore = readFileSync(manifest);
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/api/src/import-history.ts'), manifest],
      { cwd: projectRoot, env: { ...process.env, CAIXA_DB: path }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const backupPath = result.stdout.match(/Backup anterior: (.+)/)![1];
    const backup = new Database(backupPath, { readonly: true });
    try { assert.equal(backup.pragma('user_version', { simple: true }), 2); assert.deepEqual(tables.slice(0, -1).map(table => backup.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before); }
    finally { backup.close(); }
    assert.deepEqual(readFileSync(manifest), sourceBefore);
    db = openDatabase(path); const register = new CashRegister(db);
    assert.equal(register.sales().length, 6); assert.equal(register.sales().filter(sale => sale.origin === 'Planilha').length, 5);
    assert.equal(register.day('2026-10-09').summary.netCents, 5862); assert.equal(register.products()[0].stock, 9);
    assert.equal(importHistory(db, source()).alreadyImported, true);
  } finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
});

const actualSource = join(projectRoot, 'data/historico-planilha.json');
test('snapshot real da planilha importa todos os registros e fechamentos com estoque intacto em banco de teste', { skip: !existsSync(actualSource) }, () => {
  const input = JSON.parse(readFileSync(actualSource, 'utf8')) as HistoricalInput;
  const catalog = JSON.parse(readFileSync(join(projectRoot, 'data/catalogo-planilha.json'), 'utf8'));
  const db = openDatabase(':memory:'), register = new CashRegister(db);
  try {
    for (const product of catalog.products) {
      db.prepare('INSERT INTO owners(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(product.ownerName);
      const owner = register.owners().find(owner => owner.name === product.ownerName)!;
      register.saveProduct({ ...product, ownerId: owner.id });
    }
    const before = register.products(), result = importHistory(db, input);
    assert.equal(result.importedRows, input.rows.length); assert.equal(result.importedClosedDays, input.closedDays.length);
    assert.deepEqual(register.products(), before); assert.equal(register.summary().netCents, input.expected.netCents);
    for (const closing of input.closedDays) assert.equal(register.day(closing.date).summary.netCents, closing.expected.netCents);
    const allRecords = rows(db); assert.equal(importHistory(db, input).alreadyImported, true); assert.deepEqual(rows(db), allRecords);
  } finally { db.close(); }
});
