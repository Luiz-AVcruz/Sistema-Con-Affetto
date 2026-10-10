import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaleInput, Product, PaymentMethod } from '@caixa/shared';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { productSchema, saleSchema, businessDate } from '../src/validation.js';
import { projectRoot } from '../src/paths.js';

function fixture(path = ':memory:') {
  const db = openDatabase(path), register = new CashRegister(db);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?), (2,?)').run('Participante A', 'Participante B');
  const a = register.saveProduct({ name: 'Produto A', description: '', ownerId: 1, priceCents: 1500, stock: 10, active: true });
  const b = register.saveProduct({ name: 'Produto B', description: '', ownerId: 2, priceCents: 4000, stock: 3, active: true });
  return { db, register, a, b };
}
function order(products: Product[], overrides: Partial<SaleInput> = {}): SaleInput {
  return { requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Dinheiro', status: 'Pago', note: '',
    items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })), ...overrides };
}
const emptyCash = { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' };

test('pedido misto soma o pagamento e preserva a parte de cada participante', () => {
  const { db, register, a, b } = fixture();
  try {
    const sale = register.createSale(order([a, b]));
    assert.equal(sale.totalCents, 5500);
    assert.deepEqual(register.summary().byOwner.map(owner => owner.netCents), [1500, 4000]);
    assert.equal(register.summary().byPayment[0].totalCents, 5500);
    assert.deepEqual(register.products().map(product => product.stock), [9, 2]);
  } finally { db.close(); }
});
test('desconto e taxa em centavos reconciliam recebido, líquido e participantes', () => {
  const { db, register, a, b } = fixture();
  try {
    const input = order([a, b]); input.items[0].quantity = 3; input.items[0].discountCents = 101; input.items[1].feeCents = 37;
    register.createSale(input);
    const summary = register.summary();
    assert.equal(summary.receivedCents, 8399); assert.equal(summary.netCents, 8362);
    assert.equal(summary.discountCents, 101); assert.equal(summary.feeCents, 37);
    assert.deepEqual(summary.byOwner.map(owner => owner.netCents), [4399, 3963]);
    assert.equal(summary.byOwner.reduce((sum, owner) => sum+owner.netCents, 0), summary.receivedCents-summary.feeCents);
  } finally { db.close(); }
});
test('reenvio após perda de resposta não duplica venda nem estoque; mudar o corpo com a mesma chave falha', () => {
  const { db, register, a } = fixture();
  try {
    const input = order([a]); register.createSale(input); register.createSale(input);
    assert.equal(register.sales().length, 1); assert.equal(register.products()[0].stock, 9);
    assert.throws(() => register.createSale({ ...input, note: 'outro pedido' }), /outros valores/);
  } finally { db.close(); }
});
test('falta de estoque no segundo item desfaz integralmente o pedido e a primeira baixa', () => {
  const { db, register, a, b } = fixture();
  try {
    const input = order([a, b]); input.items[1].quantity = 4;
    assert.throws(() => register.createSale(input), /Estoque insuficiente/);
    assert.equal(register.sales().length, 0); assert.deepEqual(register.products().map(product => product.stock), [10,3]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sale_items').get()?.['count'], 0);
  } finally { db.close(); }
});
for (const method of ['Permuta', 'Não cobrado'] as PaymentMethod[]) test(`${method} baixa estoque e não gera receita`, () => {
  const { db, register, a } = fixture();
  try {
    register.createSale(order([a], { paymentMethod: method }));
    assert.equal(register.products()[0].stock, 9); assert.equal(register.summary().receivedCents, 0);
    assert.equal(register.summary().netCents, 0);
    assert.equal(method === 'Permuta' ? register.summary().barterUnits : register.summary().giftUnits, 1);
  } finally { db.close(); }
});
test('estoque desconhecido permanece null após uma saída e após cancelamento', () => {
  const { db, register, a } = fixture();
  try {
    register.saveProduct({ ...a, stock: null, expectedVersion: a.version }, a.id);
    const sale = register.createSale(order([a])); assert.equal(register.products()[0].stock, null);
    register.cancelSale(sale.id); assert.equal(register.products()[0].stock, null);
  } finally { db.close(); }
});
test('pendência não baixa estoque e recebimento posterior preserva fechamento anterior', () => {
  const { db, register, a } = fixture();
  try {
    const pending = register.createSale(order([a], { status: 'Pendente' }));
    assert.equal(register.products()[0].stock, 10); assert.equal(register.summary().pendingCents, 1500);
    const closed = register.closeDay('2026-10-10', emptyCash);
    register.receiveSale(pending.id, '2026-10-11', 'Pix');
    assert.deepEqual(register.day('2026-10-10'), closed);
    assert.equal(register.day('2026-10-11').summary.receivedCents, 1500);
    assert.equal(register.summary().pendingCents, 0); assert.equal(register.products()[0].stock, 9);
    register.receiveSale(pending.id, '2026-10-11', 'Pix'); assert.equal(register.products()[0].stock, 9);
  } finally { db.close(); }
});
test('receber pendência sem estoque falha sem trocar a situação', () => {
  const { db, register, a } = fixture();
  try {
    const sale = register.createSale(order([a], { status: 'Pendente' }));
    register.saveProduct({ ...a, stock: 0, expectedVersion: a.version }, a.id);
    assert.throws(() => register.receiveSale(sale.id, '2026-10-10', 'Dinheiro'), /Estoque insuficiente/);
    assert.equal(register.sales()[0].status, 'Pendente'); assert.equal(register.summary().receivedCents, 0);
  } finally { db.close(); }
});
test('alterar preço, nome ou participante não reescreve os itens antigos', () => {
  const { db, register, a } = fixture();
  try {
    const sale = register.createSale(order([a]));
    register.saveProduct({ ...a, name: 'Outro nome', ownerId: 2, priceCents: 9999, stock: 9, expectedVersion: register.products()[0].version }, a.id);
    const stored = register.sales()[0].items[0];
    assert.equal(stored.name, 'Produto A'); assert.equal(stored.ownerName, 'Participante A'); assert.equal(stored.priceCents, 1500);
    assert.deepEqual(register.summary().byOwner.map(owner => owner.netCents), [1500, 0]);
    assert.equal(register.sales()[0].id, sale.id);
    assert.throws(() => register.createSale(order([a])), /preço.*mudou/);
  } finally { db.close(); }
});
test('cancelamento devolve estoque uma única vez e retira receita', () => {
  const { db, register, a } = fixture();
  try {
    const sale = register.createSale(order([a])); register.cancelSale(sale.id); register.cancelSale(sale.id);
    assert.equal(register.products()[0].stock, 10); assert.equal(register.summary().receivedCents, 0);
  } finally { db.close(); }
});
test('dia fechado impede novos recebimentos, mudanças de contagem e cancelamentos pagos', () => {
  const { db, register, a } = fixture();
  try {
    const sale = register.createSale(order([a])); register.closeDay('2026-10-10', emptyCash);
    assert.throws(() => register.createSale(order([a])), /está fechado/);
    assert.throws(() => register.cancelSale(sale.id), /está fechado/);
    assert.throws(() => register.saveDay('2026-10-10', emptyCash), /está fechado/);
    assert.equal(register.products()[0].stock, 9);
  } finally { db.close(); }
});
test('contagem opcional distingue zero contado de ausência e usa apenas dinheiro físico', () => {
  const { db, register, a } = fixture();
  try {
    register.createSale(order([a], { paymentMethod: 'Pix' }));
    register.createSale(order([a]));
    const day = register.saveDay('2026-10-10', { ...emptyCash, openingCents: 1000, extraCents: 500, withdrawalCents: 200, countedCents: 0 });
    assert.equal(day.expectedCents, 2800); assert.equal(day.differenceCents, -2800);
    const closed = register.closeDay('2026-10-10', { ...emptyCash, openingCents: 1000 });
    assert.equal(closed.countedCents, null); assert.equal(closed.differenceCents, null);
  } finally { db.close(); }
});
test('dados sobrevivem ao encerramento da conexão e backup contém alterações ainda em WAL', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-persistencia-')), path = join(folder, 'test.sqlite');
  let db: Database.Database | undefined;
  try {
    const fixtureData = fixture(path); db = fixtureData.db;
    fixtureData.register.createSale(order([fixtureData.a]));
    fixtureData.register.closeDay('2026-10-10', emptyCash);
    const backupPath = join(folder, 'backup.sqlite');
    writeFileSync(backupPath, db.serialize());
    const restored = new Database(backupPath, { readonly: true });
    try {
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(new CashRegister(restored).summary().receivedCents, 1500);
      assert.ok(new CashRegister(restored).day('2026-10-10').closedAt);
    } finally { restored.close(); }
    db.close(); db = openDatabase(path);
    assert.equal(new CashRegister(db).summary().receivedCents, 1500);
    assert.equal(new CashRegister(db).products()[0].stock, 9);
  } finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('cadastro lido antes de uma venda não pode repor estoque ao salvar outra alteração', () => {
  const { db, register, a } = fixture();
  try {
    register.createSale(order([a]));
    assert.throws(() => register.saveProduct({ ...a, name: 'Nome corrigido', expectedVersion: a.version }, a.id), /produto mudou/);
    assert.equal(register.products()[0].stock, 9); assert.equal(register.products()[0].name, a.name);
    const current = register.products()[0];
    register.saveProduct({ ...current, name: 'Nome corrigido', expectedVersion: current.version }, current.id);
    assert.equal(register.products()[0].stock, 9);
  } finally { db.close(); }
});
test('recebimento anterior à origem do pedido é recusado sem alteração financeira ou de estoque', () => {
  const { db, register, a } = fixture();
  try {
    const sale = register.createSale(order([a], { date: '2026-10-11', status: 'Pendente' }));
    assert.throws(() => register.receiveSale(sale.id, '2026-10-10', 'Pix'), /anterior/);
    assert.equal(register.sales()[0].status, 'Pendente'); assert.equal(register.products()[0].stock, 10);
    assert.equal(register.summary().receivedCents, 0);
  } finally { db.close(); }
});
for (const legacyColumn of [false, true]) test(`migração v1 preserva registros e fechamento (${legacyColumn ? 'com' : 'sem'} coluna de versão)`, () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-migracao-')), path = join(folder, 'legacy.sqlite');
  let db: Database.Database | undefined;
  try {
    const data = fixture(path); db = data.db;
    data.register.createSale(order([data.a, data.b]));
    const product = data.register.products().find(product => product.id === data.a.id)!;
    data.register.saveProduct({ ...product, stock: 8, expectedVersion: product.version }, product.id);
    data.register.closeDay('2026-10-10', emptyCash);
    if (!legacyColumn) db.exec('ALTER TABLE products DROP COLUMN version');
    db.pragma('user_version = 1');
    const tables = ['owners','products','sales','sale_items','days','stock_adjustments'];
    const before = tables.map(table => db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    db.close(); db = openDatabase(path);
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    const actual = tables.map(table => db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    if (!legacyColumn) actual[1] = actual[1].map(row => {
      const { version, ...saved } = row as Record<string, unknown>;
      assert.equal(version, 1); return saved;
    });
    assert.deepEqual(actual, before);
    assert.equal(new CashRegister(db).bootstrap('2026-10-10').day.summary.netCents, 5500);
    const migrated = db.prepare('SELECT * FROM products ORDER BY id').all();
    db.close(); db = openDatabase(path);
    assert.deepEqual(db.prepare('SELECT * FROM products ORDER BY id').all(), migrated);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
});
test('recusar banco de versão futura preserva o modo de journal e o arquivo', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-versao-')), path = join(folder, 'future.sqlite');
  try {
    const future = new Database(path); future.pragma('user_version = 3'); future.close();
    const before = readFileSync(path);
    assert.throws(() => openDatabase(path), /versão mais nova/);
    assert.deepEqual(readFileSync(path), before);
    const check = new Database(path, { readonly: true });
    try { assert.equal(check.pragma('journal_mode', { simple: true }), 'delete'); } finally { check.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
test('contrato rejeita fração de quantidade, dinheiro fracionário, data impossível e campos extras', () => {
  assert.throws(() => businessDate.parse('2026-02-30'));
  assert.throws(() => productSchema.parse({ name: 'X', description: '', ownerId: 1, priceCents: 0.1, stock: 0, active: true }));
  assert.throws(() => saleSchema.parse({ requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Pix', status: 'Pago', note: '', items: [{ productId: 1, quantity: 1.5, expectedPriceCents: 1500, discountCents: 0, feeCents: 0 }] }));
});

const referencePath = join(projectRoot, 'data/referencia-planilha.json');
test('reconciliação com a última versão salva da planilha real', { skip: !existsSync(referencePath) }, () => {
  const source = JSON.parse(readFileSync(referencePath, 'utf8'));
  const db = openDatabase(':memory:'), register = new CashRegister(db);
  try {
    const byName = new Map<string, Product>();
    for (const product of source.products) {
      db.prepare('INSERT INTO owners(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(product.ownerName);
      const owner = register.owners().find(owner => owner.name === product.ownerName)!;
      byName.set(product.name, register.saveProduct({ ...product, ownerId: owner.id, stock: product.initialStock }));
    }
    for (const sale of source.sales) {
      if (sale.status === 'Cancelado') continue;
      register.createSale({ ...sale, requestId: randomUUID(), items: sale.items.map((item: { name: string; quantity: number; discountCents: number; feeCents: number }) => {
        const product = byName.get(item.name)!;
        return { productId: product.id, quantity: item.quantity, expectedPriceCents: product.priceCents, discountCents: item.discountCents, feeCents: item.feeCents };
      }) });
    }
    const summary = register.summary(), expected = source.expected;
    for (const key of ['netCents','discountCents','feeCents','pendingCents','barterUnits','giftUnits'] as const) assert.equal(summary[key], expected[key], key);
    assert.deepEqual(Object.fromEntries(summary.byOwner.map(owner => [owner.name,owner.netCents])), expected.byOwner);
    assert.deepEqual(Object.fromEntries(summary.byPayment.map(payment => [payment.method,payment.totalCents])), expected.byPayment);
    for (const product of register.products()) assert.equal(product.stock, source.products.find((item: Product) => item.name === product.name).stock, product.name);
  } finally { db.close(); }
});
