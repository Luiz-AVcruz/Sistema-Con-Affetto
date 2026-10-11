import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { applyPaymentFees, calculateItem, summarize } from '../../apps/api/src/finance.js';
import { openDatabase } from '../../apps/api/src/database.js';
import { CashRegister } from '../../apps/api/src/cash-register.js';
import { calculatePaymentFees, paymentMethods, type CardEntry, type Product, type SaleItemInput } from '@caixa/shared';

const binary = process.env['CAIXA_RUST_CORE_BINARY'];
assert.ok(binary, 'Execute npm run test:rust para compilar e selecionar o núcleo Rust.');
type Command = Record<string, unknown>;
type Response = { ok: true; result: unknown } | { ok: false; error: { status: number; message: string } };

function run(lines: string[], args: string[] = []) {
  return spawnSync(binary!, args, { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}
function evaluate(commands: Command[]): Response[] {
  const result = run(commands.map(command => JSON.stringify(command)));
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Response);
  assert.equal(responses.length, commands.length, 'Uma resposta para cada comando, na ordem original.');
  return responses;
}
function equivalent(commands: Command[], expected: unknown[]) {
  const responses = evaluate(commands);
  responses.forEach((response, index) => assert.deepEqual(response,
    { ok: true, result: expected[index] }, `Caso ${index}: ${JSON.stringify(commands[index]).slice(0, 250)}`));
}
function product(id = 1, priceCents = 2000): Product {
  return { id, name: `Produto fictício ${id}`, description: '', ownerId: id, ownerName: `Participante ${id}`,
    priceCents, stock: null, active: true, version: 1 };
}
function input(p = product()): SaleItemInput {
  return { productId: p.id, quantity: 1, expectedPriceCents: p.priceCents, discountCents: 0, feeCents: 0 };
}
function generator() {
  let state = 0xCA1FA;
  return (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
}

test('Rust e TypeScript concordam nas taxas e no rateio, incluindo restos e valores grandes', () => {
  const next = generator(), commands: Command[] = [], expected: unknown[] = [];
  const amountsCases = [[], [0], [0, 1000], [999,999,999,999], [1,1,15], [5000],
    [1_000_000_000_000], [Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]];
  for (let i = 0; i < 128; i++) amountsCases.push(Array.from({ length: 1 + next(100) }, () => next(100_000_001)));
  for (const amounts of amountsCases) for (const method of paymentMethods) for (const entry of [null,'Aproximação','Inserido'] as const) {
    commands.push({ operation: 'calculatePaymentFees', amounts, method, entry });
    expected.push(calculatePaymentFees(amounts, method, entry));
  }
  equivalent(commands, expected);
});

test('Rust preserva cálculo, expectativas do catálogo e campos opcionais dos itens', () => {
  const next = generator(), commands: Command[] = [], expected: unknown[] = [];
  for (let i = 0; i < 160; i++) {
    const p = product(1 + next(5), next(100_000_001)), quantity = 1 + next(10_000);
    for (const method of paymentMethods) {
      const item = { ...input(p), quantity };
      if (!['Permuta','Não cobrado'].includes(method)) {
        item.discountCents = next(Math.min(p.priceCents * quantity, 100_000_000) + 1);
        item.feeCents = next(Math.min(p.priceCents * quantity - item.discountCents, 100_000_000) + 1);
      }
      const withExpectations = i % 2 ? { ...item, expectedName: p.name, expectedOwnerId: p.ownerId, expectedOwnerName: p.ownerName } : item;
      commands.push({ operation: 'calculateItem', product: p, input: withExpectations, method });
      expected.push(calculateItem(p, withExpectations, method));
    }
  }
  equivalent(commands, expected);
});

test('recusas de negócio preservam mensagem e status da referência Node', () => {
  const p = product(), valid = input(p);
  const cases = [
    { product: { ...p, active: false }, input: valid, method: 'Pix' },
    { product: p, input: { ...valid, expectedPriceCents: 1999 }, method: 'Pix' },
    { product: p, input: { ...valid, expectedName: 'Nome anterior' }, method: 'Pix' },
    { product: p, input: { ...valid, expectedOwnerId: 9 }, method: 'Pix' },
    { product: p, input: { ...valid, expectedOwnerName: 'Nome anterior' }, method: 'Pix' },
    { product: p, input: { ...valid, discountCents: 2001 }, method: 'Dinheiro' },
    { product: p, input: { ...valid, discountCents: 100, feeCents: 1901 }, method: 'Cartão crédito' },
    { product: p, input: { ...valid, discountCents: 1 }, method: 'Permuta' },
    { product: p, input: { ...valid, feeCents: 1 }, method: 'Não cobrado' },
  ] as const;
  const expected = cases.map(item => {
    try { calculateItem(item.product, item.input, item.method); assert.fail('Deveria rejeitar'); }
    catch (error) { assert.ok(error instanceof Error && 'status' in error); return { ok: false, error: { status: error.status, message: error.message } }; }
  });
  assert.deepEqual(evaluate(cases.map(item => ({ operation: 'calculateItem', ...item }))), expected);
});

test('Rust aplica taxas sem alterar dados históricos ou a entrada', () => {
  const items = [999,999,999,999,0,2000].map((amount, index) => {
    const p = product(index + 1, amount);
    return calculateItem(p, input(p), 'Cartão crédito');
  });
  const before = structuredClone(items), commands: Command[] = [], expected: unknown[] = [];
  for (const method of paymentMethods) for (const entry of [null,'Aproximação','Inserido'] as const) {
    commands.push({ operation: 'applyPaymentFees', items, method, entry }); expected.push(applyPaymentFees(items, method, entry));
  }
  equivalent(commands, expected); assert.deepEqual(items, before);
});

test('resumos equivalentes para datas de venda/recebimento, estados, participantes e retificações já carregadas', () => {
  const next = generator(), db = openDatabase(':memory:'), register = new CashRegister(db);
  try {
    for (let id = 1; id <= 3; id++) db.prepare('INSERT INTO owners(id,name) VALUES(?,?)').run(id, `Participante ${id}`);
    const products = [1,2,3].map(ownerId => register.saveProduct({ name: `Produto ${ownerId}`, description: '', ownerId,
      priceCents: 2000, stock: 1000, active: true }));
    for (let index = 0; index < 72; index++) {
      const method = paymentMethods[index % paymentMethods.length], entry: CardEntry = index % 2 ? 'Inserido' : 'Aproximação';
      const automatic = index % 3 !== 0;
      const p = products[index % products.length];
      const status = !['Permuta','Não cobrado'].includes(method) && index % 5 === 0 ? 'Pendente' : 'Pago';
      const saved = register.createSale({ requestId: randomUUID(), date: `2026-10-${10 + index % 3}`, paymentMethod: method,
        status, note: '', ...(automatic ? { automaticFees: true as const,
          ...(method.startsWith('Cartão') ? { cardEntry: entry } : {}) } : {}),
        items: [{ ...input(p), quantity: 1 + next(5), discountCents: ['Permuta','Não cobrado'].includes(method) ? 0 : next(200) }] });
      if (status === 'Pendente' && index % 2) register.receiveSale(saved.id, '2026-10-13', 'Pix', { automaticFees: true });
      if (index % 11 === 0) register.cancelSale(saved.id);
      else if (index % 17 === 0) register.deleteSale(saved.id);
    }
    register.correctPastCardFees('Retificação fictícia para prova do contrato');
    register.closeDay('2026-10-10', { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: 'Fictício' });
    const storedSnapshot = db.prepare('SELECT snapshot FROM days WHERE date=?').get('2026-10-10');
    const sales = register.sales(), owners = register.owners(), commands: Command[] = [], expected: unknown[] = [];
    for (const selectedOwners of [owners, owners.slice(0,1), []]) for (const date of [undefined,'','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14']) {
      commands.push({ operation: 'summarize', sales, owners: selectedOwners, date }); expected.push(summarize(sales, selectedOwners, date));
    }
    equivalent(commands, expected);
    assert.deepEqual(db.prepare('SELECT snapshot FROM days WHERE date=?').get('2026-10-10'), storedSnapshot);
    // Resumos não calculam novamente a taxa histórica nem dependem do catálogo atual.
    const arbitrary = structuredClone(sales).filter(sale => sale.status === 'Pago' && sale.paymentMethod === 'Cartão débito');
    for (const sale of arbitrary) {
      for (const item of sale.items) { item.feeCents = 1; item.netCents = item.totalCents - 1; }
      sale.feeCents = sale.items.length; sale.netCents = sale.totalCents - sale.feeCents;
    }
    equivalent([{ operation: 'summarize', sales: arbitrary, owners }], [summarize(arbitrary, owners)]);
  } finally { db.close(); }
});

test('protocolo rejeita comandos inválidos sem perder o próximo comando nem aceitar caminho de banco', () => {
  const valid = JSON.stringify({ operation: 'calculatePaymentFees', amounts: [2000], method: 'Cartão débito' });
  const invalid = ['{', '{}', JSON.stringify({ operation: 'deleteSale' }),
    JSON.stringify({ operation: 'calculatePaymentFees', amounts: [-1], method: 'Pix' }),
    JSON.stringify({ operation: 'calculatePaymentFees', amounts: [0.5], method: 'Pix' }),
    JSON.stringify({ operation: 'calculatePaymentFees', amounts: [Number.MAX_SAFE_INTEGER + 1], method: 'Pix' }),
    JSON.stringify({ operation: 'calculatePaymentFees', amounts: [2000], method: 'Bitcoin' }),
    JSON.stringify({ operation: 'calculatePaymentFees', amounts: [2000], method: 'Pix', database: '/tmp/nao-abrir.sqlite' })];
  const result = run([...invalid, valid]); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Response);
  assert.equal(responses.length, invalid.length + 1);
  for (const response of responses.slice(0,-1)) { assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.status, 400); }
  assert.deepEqual(responses.at(-1), { ok: true, result: [18] });
  const withBankArgument = run([valid], ['/tmp/nao-abrir.sqlite']);
  assert.equal(withBankArgument.status, 1); assert.equal(withBankArgument.stdout, '');
});

test('JSON bruto preserva inteiros com decimal, expoente e zero negativo, inclusive no limite exato', () => {
  const literals = ['2000.0','2e3','2E+3','200000e-2','-0','-0.0','0e0',
    '9007199254740991.0','9007199254740991e0','9.007199254740991e15','9007199254740990.0'];
  const lines: string[] = [], expected: unknown[] = [];
  for (const literal of literals) {
    const feeLine = `{"operation":"calculatePaymentFees","amounts":[${literal}],"method":"Cartão débito"}`;
    const { amounts } = JSON.parse(feeLine) as { amounts: number[] };
    assert.ok(Number.isSafeInteger(amounts[0]));
    lines.push(feeLine); expected.push({ ok: true, result: calculatePaymentFees(amounts, 'Cartão débito') });
    const summaryLine = `{"operation":"summarize","owners":[],"sales":[{"date":"2026-10-10","paymentDate":null,"paymentMethod":"Dinheiro","status":"Pendente","items":[],"discountCents":0,"feeCents":0,"totalCents":${literal},"netCents":0}]}`;
    const parsed = JSON.parse(summaryLine);
    lines.push(summaryLine); expected.push({ ok: true, result: summarize(parsed.sales, parsed.owners) });
  }
  // Exercita os campos numéricos aninhados, inclusive expectativas opcionais e stock.
  const p = product(), item = { ...input(p), expectedOwnerId: p.ownerId };
  const itemCommand = { operation: 'calculateItem', product: { ...p, stock: 10 }, input: item, method: 'Pix' };
  lines.push(JSON.stringify(itemCommand).replace(/(?<=[\[:,])(-?\d+)(?=[,}\]])/g, '$1.0'));
  expected.push({ ok: true, result: calculateItem(itemCommand.product, item, 'Pix') });
  const result = run(lines); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), expected);
});
