import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { SaleInput, WorkspaceState } from '@caixa/shared';
import { parseWorkspaceState } from '@caixa/shared';
import { BusinessError } from '../src/validation.js';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { captureSnapshot, prepareSnapshot, readWorkspace, restoreSnapshot, snapshotFingerprint } from '../src/snapshot.js';

const date = '2026-10-10';
const businessTables = ['owners', 'products', 'fairs', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records'] as const;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const businessRows = (db: Database.Database) => businessTables.map(table => db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all());

function makeState(payload: SaleInput, product: ReturnType<CashRegister['products']>[number], view: WorkspaceState['view'] = 'Vender') {
  const draft = {
    version: 2,
    fairId: payload.fairId!,
    requestId: payload.requestId,
    date: payload.date,
    items: [{ product, quantity: payload.items[0]!.quantity, discount: '0,00', fee: '' }],
    method: payload.paymentMethod,
    status: payload.status,
    note: payload.note,
    catalogExpectations: true,
    pendingSubmission: payload
  };
  const raw = JSON.stringify(draft, null, 2);
  return {
    raw,
    state: parseWorkspaceState({ version: 1, date, fairId: payload.fairId, view, drafts: { [`caixa-feira-draft-v2-${payload.fairId}`]: raw } })
  };
}

function fixture(label: string, priceCents: number, quantity: number) {
  const db = openDatabase(':memory:');
  const register = new CashRegister(db, 1);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run(`Participante ${label}`);
  const product = register.saveProduct({ name: `Produto ${label}`, description: `Descrição ${label}`, ownerId: 1, priceCents, stock: 40, active: true });
  const payload: SaleInput = {
    requestId: randomUUID(), fairId: 1, date, paymentMethod: 'Pix', status: 'Pago', note: `pedido ${label}`,
    items: [{ productId: product.id, quantity, expectedPriceCents: product.priceCents, expectedName: product.name,
      expectedOwnerId: product.ownerId, expectedOwnerName: product.ownerName, discountCents: 0, feeCents: 0 }]
  };
  register.createSale(payload);
  register.closeDay(date, { openingCents: 2500, extraCents: 1000, withdrawalCents: 200, countedCents: 9200, note: `fechamento ${label}` });
  db.prepare('INSERT INTO stock_adjustments(product_id,before_stock,after_stock,reason,created_at) VALUES(?,?,?,?,?)')
    .run(product.id, 39, 40, `ajuste ${label}`, new Date().toISOString());
  db.prepare(`INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,day_date,source_sha256,imported_at,fair_id)
    VALUES(?,?,?, ?,NULL,?,?,1)`)
    .run(`origem-${label}`, 'Vendas:1', `hash-${label}`, payload.requestId, `sha-${label}`, new Date().toISOString());
  register.closeFair(date);
  register.createFair({ name: `Próxima feira ${label}`, targetCents: null, startDate: date });
  const state = makeState(payload, register.products()[0]!);
  return { db, register, payload, state };
}

function changeSnapshot(bytes: Buffer, change: (db: Database.Database) => void): Buffer {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-snapshot-mutate-'));
  const path = join(folder, 'edit.sqlite');
  writeFileSync(path, bytes);
  const db = new Database(path);
  try {
    change(db);
    return db.serialize();
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
}

function assertBusinessError(action: () => unknown, status: number): BusinessError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof BusinessError, 'esperava BusinessError');
  assert.equal(caught.status, status);
  return caught;
}

test('captura dentro da transação produz imagem independente completa e mantém drafts literalmente', () => {
  const world = fixture('A', 1750, 2);
  let prepared: ReturnType<typeof prepareSnapshot> | undefined;
  try {
    const captured = captureSnapshot(world.db, world.state.state);
    const sourceHash = sha256(captured.bytes);
    prepared = prepareSnapshot(captured.bytes);
    assert.equal(sha256(captured.bytes), sourceHash, 'a preparação não altera o buffer de origem');
    assert.equal(prepared.workspace.generation, captured.workspace.generation);
    assert.equal(prepared.workspace.state.drafts['caixa-feira-draft-v2-1'], world.state.raw);
    assert.deepEqual(prepared.summary, {
      savedAt: captured.workspace.savedAt, date, view: 'Vender', fairId: 1,
      owners: 1, products: 1, sales: 1, days: 1, fairs: 2, drafts: 1
    });
    const sourceRows = businessRows(world.db);
    world.db.close();
    const isolated = new Database(prepared.path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(isolated.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(businessRows(isolated), sourceRows);
      assert.equal(readWorkspace(isolated)?.state.drafts['caixa-feira-draft-v2-1'], world.state.raw);
    } finally { isolated.close(); }
  } finally {
    if (world.db.open) world.db.close();
    prepared?.dispose();
  }
});

test('importa todos os registros A sobre IDs iguais de B, guarda backup completo com o estado anterior e retry não duplica venda', () => {
  const source = fixture('A', 1800, 3), target = fixture('B', 7300, 4);
  const folder = mkdtempSync(join(tmpdir(), 'caixa-snapshot-import-'));
  let candidate: ReturnType<typeof prepareSnapshot> | undefined;
  let backup: ReturnType<typeof prepareSnapshot> | undefined;
  try {
    const sourceImage = captureSnapshot(source.db, source.state.state);
    captureSnapshot(target.db, target.state.state);
    candidate = prepareSnapshot(sourceImage.bytes);
    const expectedFingerprint = snapshotFingerprint(target.db);
    const priorBusiness = businessRows(target.db);
    const operationId = randomUUID();
    const imported = restoreSnapshot(target.db, candidate, target.state.state, expectedFingerprint, folder, operationId);
    assert.equal(imported.importId, operationId);
    assert.deepEqual(businessRows(target.db), businessRows(source.db));
    assert.deepEqual(imported.state, source.state.state);
    assert.ok(imported.backupPath);
    assert.equal(readWorkspace(target.db)?.backupPath, imported.backupPath);
    backup = prepareSnapshot(readFileSync(imported.backupPath));
    const previousDb = new Database(backup.path, { readonly: true });
    try { assert.deepEqual(businessRows(previousDb), priorBusiness); } finally { previousDb.close(); }
    assert.deepEqual(backup.workspace.state, target.state.state, 'o backup usa o estado atual de B, não o workspace antigo');

    const stockBeforeRetry = target.register.products()[0]!.stock;
    const saleCountBeforeRetry = target.db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number };
    const retry = target.register.createSale(source.payload);
    assert.equal(retry.id, source.payload.requestId);
    assert.equal(target.register.products()[0]!.stock, stockBeforeRetry);
    assert.equal((target.db.prepare('SELECT COUNT(*) AS count FROM sales').get() as { count: number }).count, saleCountBeforeRetry.count);
    assertBusinessError(() => target.register.createSale({ ...source.payload, note: `${source.payload.note} alterado` }), 409);

    const backupsBeforeRetry = readWorkspace(target.db)?.backupPath;
    const repeated = restoreSnapshot(target.db, candidate, source.state.state, '0'.repeat(64), folder, operationId);
    assert.deepEqual(repeated, imported);
    assert.equal(readWorkspace(target.db)?.backupPath, backupsBeforeRetry);
  } finally {
    if (source.db.open) source.db.close();
    if (target.db.open) target.db.close();
    backup?.dispose(); candidate?.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('recusa estado de draft e arquivos com banco futuro, schema extra ou JSON de draft quebrado sem tocar nas fontes', () => {
  const source = fixture('inválido', 1900, 1);
  try {
    const captured = captureSnapshot(source.db, source.state.state);
    const originalHash = sha256(captured.bytes);
    const draft = JSON.parse(source.state.raw) as Record<string, unknown>;
    const badState = { ...source.state.state, drafts: { 'caixa-feira-draft-v2-1': JSON.stringify({ ...draft, requestId: 'não-é-uuid' }) } };
    assert.throws(() => parseWorkspaceState(badState), /Estado do aplicativo inválido/);
    const oversizedDrafts = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => {
      const fairId = index + 1;
      return [`caixa-feira-draft-v2-${fairId}`, JSON.stringify({ version: 2, fairId, requestId: randomUUID(), date,
        items: [], method: 'Dinheiro', status: 'Pago', note: 'x'.repeat(500) })];
    }));
    assert.throws(() => parseWorkspaceState({ version: 1, date, fairId: 1, view: 'Vender', drafts: oversizedDrafts }), /ultrapassa 1 MiB/);

    const future = changeSnapshot(captured.bytes, db => db.pragma('user_version = 7'));
    const unknownSchema = changeSnapshot(captured.bytes, db => db.exec('CREATE TABLE outro_programa(id INTEGER)'));
    const malformedDraft = changeSnapshot(captured.bytes, db => db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify({ ...badState, drafts: { 'caixa-feira-draft-v2-1': '{quebrado' } })));
    for (const candidate of [Buffer.from('texto'), future, unknownSchema, malformedDraft]) {
      assert.throws(() => prepareSnapshot(candidate), (error: unknown) => error instanceof BusinessError && error.status === 400);
    }
    assert.equal(sha256(captured.bytes), originalHash);
  } finally { source.db.close(); }
});

test('fingerprint stale, falha ao criar backup e falha real ao copiar fazem rollback sem perder registros', () => {
  const source = fixture('A', 1800, 3), target = fixture('B', 7300, 4);
  const folder = mkdtempSync(join(tmpdir(), 'caixa-snapshot-rollback-'));
  const blocker = join(folder, 'arquivo-nao-diretorio');
  writeFileSync(blocker, 'x');
  let candidate: ReturnType<typeof prepareSnapshot> | undefined;
  try {
    candidate = prepareSnapshot(captureSnapshot(source.db, source.state.state).bytes);
    captureSnapshot(target.db, target.state.state);
    const fingerprint = snapshotFingerprint(target.db);
    const beforeRows = businessRows(target.db);
    const beforeWorkspace = readWorkspace(target.db);
    assertBusinessError(() => restoreSnapshot(target.db, candidate!, target.state.state, 'f'.repeat(64), folder, randomUUID()), 409);
    assert.equal(snapshotFingerprint(target.db), fingerprint);
    assert.throws(() => restoreSnapshot(target.db, candidate!, target.state.state, fingerprint, blocker, randomUUID()));
    assert.deepEqual(businessRows(target.db), beforeRows);
    assert.deepEqual(readWorkspace(target.db), beforeWorkspace);

    target.db.exec(`CREATE TRIGGER injected_import_failure BEFORE INSERT ON products
      BEGIN SELECT RAISE(ABORT, 'falha injetada'); END`);
    assert.throws(() => restoreSnapshot(target.db, candidate!, target.state.state, fingerprint, folder, randomUUID()), /falha injetada/);
    assert.deepEqual(businessRows(target.db), beforeRows);
    assert.deepEqual(readWorkspace(target.db), beforeWorkspace);
    assert.equal(snapshotFingerprint(target.db), fingerprint);
    assert.deepEqual(readdirSync(folder).filter(name => name.endsWith('.caixa')), []);
  } finally {
    if (source.db.open) source.db.close();
    if (target.db.open) target.db.close();
    candidate?.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});

