import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PaymentMethod, Product, SaleInput } from '@caixa/shared';
import Database from 'better-sqlite3';
import { openDatabase, schemaVersion } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { createApp } from '../src/app.js';
import { withoutDeletedAt } from './legacy-database.js';

const date = '2026-10-10';
const cash = { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' };
const tables = ['owners', 'products', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records', 'fairs'];
const rows = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]);
function fixture(path = ':memory:') {
  const db = openDatabase(path), register = new CashRegister(db);
  db.exec("INSERT INTO owners(id,name) VALUES(1,'Participante A'),(2,'Participante B')");
  const products = [1, 2].map(ownerId => register.saveProduct({ name: `Produto ${ownerId}`, description: '', ownerId,
    priceCents: ownerId * 1500, stock: 10, active: true }));
  return { db, register, products };
}
function order(products: Product[], overrides: Partial<SaleInput> = {}): SaleInput {
  return { requestId: randomUUID(), date, paymentMethod: 'Dinheiro', status: 'Pago', note: '',
    items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })), ...overrides };
}

test('excluir pedido misto corrige todos os resumos e estoque uma única vez sem perder a proteção de reenvio', () => {
  const { db, register, products } = fixture();
  try {
    const input = order(products); input.items[0]!.discountCents = 100; input.items[1]!.feeCents = 37;
    const sale = register.createSale(input);
    register.saveDay(date, { ...cash, openingCents: 1000, countedCents: 1000 });
    assert.equal(register.summary().netCents, 4363);
    assert.deepEqual(register.deleteSale(sale.id), { id: sale.id, deleted: true });
    assert.deepEqual(register.sales(), []);
    const summary = register.summary();
    for (const field of ['receivedCents', 'netCents', 'pendingCents', 'discountCents', 'feeCents', 'paidCount'] as const) assert.equal(summary[field], 0);
    assert.deepEqual(summary.byOwner.map(owner => owner.netCents), [0, 0]);
    assert.ok(summary.byPayment.every(payment => payment.totalCents === 0));
    assert.equal(register.day(date).expectedCents, 1000); assert.equal(register.day(date).differenceCents, 0);
    assert.equal(register.fair().summary.netCents, 0);
    assert.deepEqual(register.products().map(product => product.stock), [10, 10]);
    assert.deepEqual(register.products().map(product => product.version), [3, 3]);
    const before = rows(db);
    register.deleteSale(sale.id);
    assert.deepEqual(rows(db), before);
    assert.throws(() => register.createSale(input), { status: 410 });
    assert.throws(() => register.createSale({ ...input, note: 'Outro conteúdo' }), { status: 409 });
    assert.throws(() => register.receiveSale(sale.id, date, 'Pix'), { status: 404 });
    assert.throws(() => register.cancelSale(sale.id), { status: 404 });
    assert.deepEqual(rows(db), before);
  } finally { db.close(); }
});

for (const state of ['Pendente', 'Cancelado'] as const) test(`excluir ${state} não devolve estoque sem uma baixa atual`, () => {
  const { db, register, products } = fixture();
  try {
    const sale = register.createSale(order(products, { status: state === 'Pendente' ? state : 'Pago' }));
    if (state === 'Cancelado') register.cancelSale(sale.id);
    const catalog = register.products();
    register.deleteSale(sale.id); register.deleteSale(sale.id);
    assert.deepEqual(register.products(), catalog); assert.equal(register.summary().pendingCents, 0);
    assert.deepEqual(register.sales(), []);
  } finally { db.close(); }
});

for (const method of ['Permuta', 'Não cobrado'] as PaymentMethod[]) test(`excluir ${method} corrige unidades e preserva estoque desconhecido`, () => {
  const { db, register, products } = fixture();
  try {
    register.saveProduct({ ...products[1]!, stock: null, expectedVersion: products[1]!.version }, products[1]!.id);
    const sale = register.createSale(order(products, { paymentMethod: method }));
    assert.deepEqual(register.products().map(product => product.stock), [9, null]);
    register.deleteSale(sale.id);
    assert.deepEqual(register.products().map(product => product.stock), [10, null]);
    assert.equal(register.summary().barterUnits, 0); assert.equal(register.summary().giftUnits, 0);
    assert.equal(register.summary().receivedCents, 0); assert.equal(register.summary().paidCount, 0);
  } finally { db.close(); }
});

test('erro na devolução do segundo item desfaz estoque, versões e exclusão do primeiro', () => {
  const { db, register, products } = fixture();
  try {
    const sale = register.createSale(order(products));
    db.exec(`CREATE TRIGGER fail_second_return BEFORE UPDATE OF stock ON products
      WHEN NEW.id=2 AND NEW.stock>OLD.stock BEGIN SELECT RAISE(ABORT,'falha de teste na segunda devolução'); END;`);
    const before = rows(db);
    assert.throws(() => register.deleteSale(sale.id), /segunda devolução/);
    assert.deepEqual(rows(db), before); assert.equal(register.sales().length, 1);
    db.exec('DROP TRIGGER fail_second_return'); register.deleteSale(sale.id);
    assert.deepEqual(register.products().map(product => product.stock), [10, 10]);
  } finally { db.close(); }
});

test('dia do pedido fechado protege pendentes e cancelados; recebimento fechado também protege pagos', () => {
  for (const state of ['Pendente', 'Cancelado', 'Pago'] as const) {
    const { db, register, products } = fixture();
    try {
      const sale = register.createSale(order(products, { status: 'Pendente' }));
      if (state === 'Cancelado') register.cancelSale(sale.id);
      if (state === 'Pago') register.receiveSale(sale.id, '2026-10-11', 'Pix');
      register.closeDay(date, cash);
      const before = rows(db);
      assert.throws(() => register.deleteSale(sale.id), /está fechado/);
      assert.deepEqual(rows(db), before);
    } finally { db.close(); }
  }
  const { db, register, products } = fixture();
  try {
    const sale = register.createSale(order(products, { status: 'Pendente' }));
    register.receiveSale(sale.id, '2026-10-11', 'Dinheiro'); register.closeDay('2026-10-11', cash);
    const before = rows(db);
    assert.throws(() => register.deleteSale(sale.id), /está fechado/); assert.deepEqual(rows(db), before);
  } finally { db.close(); }
});

test('exclusão não atravessa feiras; feira encerrada preserva os pedidos e retry excluído continua inofensivo', () => {
  const { db, register, products } = fixture();
  try {
    const kept = register.createSale(order(products));
    const deleted = register.createSale(order(products)); register.deleteSale(deleted.id);
    register.closeFair(date);
    const next = register.createFair({ name: 'Próxima', targetCents: null, startDate: date });
    const active = new CashRegister(db, next.id), before = rows(db);
    assert.throws(() => register.deleteSale(kept.id), /encerrada/);
    assert.throws(() => active.deleteSale(kept.id), { status: 404 });
    assert.throws(() => active.deleteSale(deleted.id), { status: 404 });
    register.deleteSale(deleted.id);
    assert.deepEqual(rows(db), before); assert.equal(register.fair().summary.netCents, 4500);
  } finally { db.close(); }
});

test('migração v4 acrescenta somente marcador vazio e preserva todas as tabelas e snapshots', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-exclusao-v4-')), path = join(folder, 'old.sqlite');
  let db: Database.Database | undefined;
  try {
    const data = fixture(path); db = data.db;
    const sale = data.register.createSale(order(data.products));
    data.register.closeDay(date, cash);
    db.prepare('INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,source_sha256,imported_at,fair_id) VALUES(?,?,?,?,?,?,1)')
      .run('caixa-da-feira-ods', 'Vendas:6', 'hash original', sale.id, 'origem', new Date().toISOString());
    db.exec('ALTER TABLE sales DROP COLUMN deleted_at; PRAGMA user_version = 4');
    const before = rows(db);
    db.close(); db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), schemaVersion);
    assert.deepEqual(rows(db).map(withoutDeletedAt), before);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    const after = rows(db); db.close(); db = openDatabase(path); assert.deepEqual(rows(db), after);
  } finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('HTTP DELETE valida origem/corpo, some dos CSVs, reenvio não ressuscita e backup conserva exclusão', async () => {
  const { db, register, products } = fixture();
  const server = createApp(register).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const input = order(products), sale = register.createSale(input), path = `/api/sales/${sale.id}?fairId=1`;
  const api = (endpoint: string, body: unknown = {}, method = 'DELETE', origin?: string) => fetch(url + endpoint, {
    method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body)
  });
  try {
    assert.equal((await api(path, {}, 'DELETE', 'https://externo.example')).status, 403);
    assert.equal((await fetch(url + path, { method: 'DELETE' })).status, 415);
    assert.equal((await api(path, { unexpected: true })).status, 400);
    assert.equal((await api(`/api/sales/${randomUUID()}?fairId=1`)).status, 404);
    assert.equal(register.sales().length, 1);
    const responses = await Promise.all([api(path), api(path)]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.deepEqual(await responses[0]!.json(), { id: sale.id, deleted: true });
    const data = await (await fetch(url + '/api/bootstrap?date=' + date)).json();
    assert.deepEqual(data.sales, []); assert.equal(data.day.summary.netCents, 0);
    assert.deepEqual(data.products.map((product: Product) => product.stock), [10, 10]);
    const csv = await (await fetch(url + '/api/export/sales.csv')).text();
    const days = await (await fetch(url + '/api/export/days.csv')).text();
    assert.ok(!csv.includes(sale.id)); assert.equal(csv.split('\r\n').length, 1);
    assert.equal(days.split('\r\n').length, 1, 'data presente só em pedido excluído não gera fechamento fictício');
    const retry = await api('/api/sales', input, 'POST'); assert.equal(retry.status, 410);
    const backup = Buffer.from(await (await fetch(url + '/api/backup')).arrayBuffer());
    const check = new Database(backup);
    try {
      assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(new CashRegister(check).sales().length, 0);
      assert.deepEqual(new CashRegister(check).products().map(product => product.stock), [10, 10]);
      assert.ok(check.prepare('SELECT deleted_at FROM sales WHERE id=?').get(sale.id)?.['deleted_at']);
    } finally { check.close(); }
    const kept = register.createSale(order(products)); register.closeDay(date, cash);
    const before = rows(db);
    assert.equal((await api(`/api/sales/${kept.id}?fairId=1`)).status, 409);
    assert.equal((await api(`/api/sales/${kept.id}?fairId=999`)).status, 404);
    assert.deepEqual(rows(db), before);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
