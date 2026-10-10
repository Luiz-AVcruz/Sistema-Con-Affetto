import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { importHistory, type HistoricalInput } from '../src/historical-import.js';
import { appendHistory } from '../src/append-history.js';
import { projectRoot } from '../src/paths.js';

function initial(): HistoricalInput {
  const expected = { receivedCents: 1000, netCents: 987, discountCents: 0, feeCents: 13,
    pendingCents: 1000, barterUnits: 0, giftUnits: 0,
    byOwner: { 'Participante A': 987, 'Participante B': 0 },
    byPayment: { 'Dinheiro': 0, 'Pix': 1000, 'Cartão débito': 0, 'Cartão crédito': 0 } };
  const row = { rowNumber: 6, orderRef: 'pedido antigo', date: '2026-10-09', paymentMethod: 'Pix' as const,
    status: 'Pago' as const, note: '', name: 'Produto A', ownerName: 'Participante A',
    quantity: 1, priceCents: 1000, discountCents: 0, feeCents: 13, totalCents: 1000, netCents: 987 };
  return { formatVersion: 1, sourceKey: 'caixa-da-feira-ods', source: 'fonte de teste.ods', sha256: 'a'.repeat(64), lockPresent: false,
    products: [{ name: 'Produto A', stock: 5 }, { name: 'Produto B', stock: 3 }],
    rows: [row, { ...row, rowNumber: 7, orderRef: '', status: 'Pendente', paymentMethod: 'Dinheiro', feeCents: 0, netCents: 1000 }], expected,
    closedDays: [{ date: '2026-10-09', cash: { openingCents: 200, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' },
      expectedCents: 200, differenceCents: null, expected: structuredClone(expected) }] };
}

function updated(): HistoricalInput {
  const source = initial(); source.sha256 = 'b'.repeat(64);
  source.products = [{ name: 'Produto A', stock: 3 }, { name: 'Produto B', stock: 2 }];
  const row = { ...source.rows[0], rowNumber: 8, orderRef: 'novo pedido misto', date: '2026-10-10',
    paymentMethod: 'Cartão crédito' as const, quantity: 2, discountCents: 101, feeCents: 37, totalCents: 1899, netCents: 1862 };
  source.rows.push(row, { ...row, rowNumber: 9, name: 'Produto B', ownerName: 'Participante B', quantity: 1,
    priceCents: 2000, discountCents: 0, feeCents: 11, totalCents: 2000, netCents: 1989 });
  source.expected = { receivedCents: 4899, netCents: 4838, discountCents: 101, feeCents: 61,
    pendingCents: 1000, barterUnits: 0, giftUnits: 0,
    byOwner: { 'Participante A': 2849, 'Participante B': 1989 },
    byPayment: { 'Dinheiro': 0, 'Pix': 1000, 'Cartão débito': 0, 'Cartão crédito': 3899 } };
  return source;
}

function fixture(path = ':memory:', unknownStock = false) {
  const db = openDatabase(path), register = new CashRegister(db);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?), (2,?)').run('Participante A', 'Participante B');
  register.saveProduct({ name: 'Produto A', description: '', ownerId: 1, priceCents: 1000, stock: 5, active: true });
  register.saveProduct({ name: 'Produto B', description: '', ownerId: 2, priceCents: 2000, stock: unknownStock ? null : 3, active: true });
  const source = initial(); if (unknownStock) source.products[1].stock = null;
  importHistory(db, source);
  return { db, register };
}
const tables = ['fairs', 'owners', 'products', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records'];
const state = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('append agrupa itens novos, baixa só essas unidades e preserva vendas, hashes e fechamento antigos', () => {
  const { db, register } = fixture();
  try {
    const before = state(db), closing = register.day('2026-10-09'), old = register.sales();
    assert.deepEqual(appendHistory(db, updated()), { importedOrders: 1, importedRows: 2, importedClosedDays: 0, reconciledProducts: 0, alreadyImported: false });
    assert.equal(register.summary('2026-10-10').receivedCents, 3899);
    assert.equal(register.summary('2026-10-10').netCents, 3851);
    assert.equal(register.summary().netCents, 4838);
    assert.deepEqual(register.products().map(product => [product.stock, product.version]), [[3, 2], [2, 2]]);
    assert.deepEqual(register.day('2026-10-09'), closing);
    for (const sale of old) assert.deepEqual(register.sales().find(saved => saved.id === sale.id), sale);
    const after = state(db);
    for (const index of [0, 1, 3, 4, 5, 6, 7]) assert.deepEqual(after[index].slice(0, before[index].length), before[index]);
    const added = register.sales().find(sale => sale.date === '2026-10-10')!;
    assert.equal(added.origin, 'Planilha'); assert.equal(added.items.length, 2);
    assert.equal(added.items[0].priceCents, 1000); assert.equal(added.items[1].ownerName, 'Participante B');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('repetição não baixa estoque nem desfaz recebimento, cancelamento ou exclusão posteriores', () => {
  for (const action of ['none', 'cancel', 'delete', 'receive'] as const) {
    const { db, register } = fixture();
    try {
      const source = updated(); appendHistory(db, source);
      const added = register.sales().find(sale => sale.date === '2026-10-10')!;
      if (action === 'cancel') register.cancelSale(added.id);
      if (action === 'delete') register.deleteSale(added.id);
      if (action === 'receive') register.receiveSale(register.sales().find(sale => sale.status === 'Pendente')!.id, '2026-10-10', 'Pix');
      const before = state(db);
      assert.equal(appendHistory(db, { ...source, sha256: 'c'.repeat(64), source: 'outro caminho.ods' }).alreadyImported, true);
      assert.deepEqual(state(db), before);
    } finally { db.close(); }
  }
});

test('origem antiga editada, removida ou deslocada e acréscimo em pedido antigo recusam sem gravar', () => {
  const { db } = fixture();
  try {
    const before = state(db);
    const edited = updated(); edited.rows[0].note = 'mudou';
    const removed = updated(); removed.rows.shift();
    const shifted = updated(); shifted.rows[0].rowNumber = 5;
    const oldOrder = updated(); oldOrder.rows[2].date = '2026-10-09'; oldOrder.rows[2].orderRef = 'pedido antigo';
    const inserted = updated(); inserted.rows[2].rowNumber = 5;
    for (const source of [edited, removed, shifted, oldOrder, inserted]) {
      assert.throws(() => appendHistory(db, source), /anterior|pedido já importado|depois das vendas/);
      assert.deepEqual(state(db), before);
    }
    assert.throws(() => importHistory(db, updated()), /mudou desde a migração/);
    assert.deepEqual(state(db), before);
  } finally { db.close(); }
});

test('divergência no último item, total, rateio, pagamento ou estoque desfaz a transação inteira', () => {
  const { db } = fixture();
  try {
    const before = state(db);
    const badItem = updated(); badItem.rows[3].netCents--;
    const badTotal = updated(); badTotal.expected.netCents--;
    const badOwner = updated(); badOwner.expected.byOwner['Participante B']--;
    const badPayment = updated(); badPayment.expected.byPayment['Cartão crédito']--;
    const badStock = updated(); badStock.products[1].stock = 3;
    for (const source of [badItem, badTotal, badOwner, badPayment, badStock]) {
      assert.throws(() => appendHistory(db, source), /diverge|divergentes/);
      assert.deepEqual(state(db), before);
    }
  } finally { db.close(); }
});

test('contagem manual que já inclui saídas da fonte não é reduzida de novo', () => {
  const { db, register } = fixture();
  try {
    const product = register.products()[0];
    register.saveProduct({ ...product, stock: 3, expectedVersion: product.version }, product.id);
    const before = state(db);
    assert.throws(() => appendHistory(db, updated()), /estoque final diverge/);
    assert.deepEqual(state(db), before);
  } finally { db.close(); }
});

test('estoque desconhecido permanece desconhecido e dias fechados ou novo fechamento são preservados', () => {
  const unknown = fixture(':memory:', true);
  try {
    const source = updated(); source.products[1].stock = null;
    appendHistory(unknown.db, source);
    assert.deepEqual(unknown.register.products().map(product => product.stock), [3, null]);
  } finally { unknown.db.close(); }
  const { db, register } = fixture();
  try {
    register.closeDay('2026-10-10', { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' });
    const before = state(db);
    assert.throws(() => appendHistory(db, updated()), /está fechado/); assert.deepEqual(state(db), before);
    const source = updated(); source.closedDays.push({ ...source.closedDays[0], date: '2026-10-10' });
    assert.throws(() => appendHistory(db, source), /Novos fechamentos/); assert.deepEqual(state(db), before);
  } finally { db.close(); }
});

test('preço e participante divergentes ou produto inativo não são sobrescritos para aceitar a origem', () => {
  for (const change of ['price', 'owner', 'active'] as const) {
    const { db, register } = fixture();
    try {
      const product = register.products()[0];
      register.saveProduct({ ...product, priceCents: change === 'price' ? 1500 : product.priceCents,
        ownerId: change === 'owner' ? 2 : product.ownerId, active: change !== 'active', expectedVersion: product.version }, product.id);
      const before = state(db);
      assert.throws(() => appendHistory(db, updated()), /Preço ou participante|Produto inativo/);
      assert.deepEqual(state(db), before);
    } finally { db.close(); }
  }
});

test('CLI cria backup completo antes do append e dados persistem sem alterar a fonte JSON', () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-append-cli-')), path = join(folder, 'caixa.sqlite');
  let db: Database.Database | undefined;
  try {
    ({ db } = fixture(path)); const before = state(db); db.close(); db = undefined;
    const manifest = join(folder, 'historico.json'); writeFileSync(manifest, JSON.stringify(updated()));
    const sourceBytes = readFileSync(manifest);
    const run = (flags: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'apps/api/src/import-history.ts'), manifest, ...flags],
      { cwd: projectRoot, env: { ...process.env, CAIXA_DB: path }, encoding: 'utf8' });
    const incompatible = run(['--append', '--reconcile-stock']); assert.notEqual(incompatible.status, 0);
    db = openDatabase(path); assert.deepEqual(state(db), before); db.close(); db = undefined;
    const result = run(['--append']); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 linhas novas em 1 pedidos acrescentadas/);
    const backup = new Database(result.stdout.match(/Backup anterior: (.+)/)![1], { readonly: true });
    try { assert.deepEqual(state(backup), before); } finally { backup.close(); }
    assert.deepEqual(readFileSync(manifest), sourceBytes);
    db = openDatabase(path); const register = new CashRegister(db);
    assert.equal(register.sales().length, 3); assert.equal(register.summary().netCents, 4838);
    assert.deepEqual(register.products().map(product => product.stock), [3, 2]);
    const saved = state(db); db.close(); db = undefined;
    const replay = run(['--append']); assert.equal(replay.status, 0, replay.stderr); assert.match(replay.stdout, /Histórico já importado/);
    db = openDatabase(path); assert.deepEqual(state(db), saved);
  } finally { if (db?.open) db.close(); rmSync(folder, { recursive: true, force: true }); }
});
