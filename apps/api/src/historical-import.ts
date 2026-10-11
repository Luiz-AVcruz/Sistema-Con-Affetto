import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { paymentMethods, type Day, type Sale, type Summary } from '@caixa/shared';
import { CashRegister } from './cash-register.js';
import { calculateItem, isNonCash, summarize } from './finance.js';
import { businessDate, cashSchema, money, requireCondition } from './validation.js';

const name = z.string().trim().min(1).max(100);
const expectedSchema = z.object({
  receivedCents: money, netCents: money, discountCents: money, feeCents: money,
  pendingCents: money, barterUnits: z.number().int().nonnegative(), giftUnits: z.number().int().nonnegative(),
  byOwner: z.record(name, money),
  byPayment: z.object({ 'Dinheiro': money, 'Pix': money, 'Cartão débito': money, 'Cartão crédito': money }).strict()
}).strict();
const rowSchema = z.object({
  rowNumber: z.number().int().positive(), orderRef: z.string().trim().max(100), date: businessDate,
  paymentMethod: z.enum(paymentMethods), status: z.enum(['Pago', 'Pendente', 'Cancelado']),
  note: z.string().trim().max(500), name, ownerName: name,
  quantity: z.number().int().min(1).max(10_000), priceCents: money,
  discountCents: money, feeCents: money, totalCents: money, netCents: money
}).strict();
export const historySchema = z.object({
  formatVersion: z.literal(1), sourceKey: z.literal('caixa-da-feira-ods'),
  source: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), lockPresent: z.boolean(),
  products: z.array(z.object({ name, stock: z.number().int().min(0).max(1_000_000).nullable() }).strict()).min(1),
  rows: z.array(rowSchema).min(1).max(10_000), expected: expectedSchema,
  closedDays: z.array(z.object({ date: businessDate, cash: cashSchema,
    expectedCents: z.number().int().nullable(), differenceCents: z.number().int().nullable(), expected: expectedSchema
  }).strict())
}).strict();
export type HistoricalInput = z.infer<typeof historySchema>;
type HistoricalRow = HistoricalInput['rows'][number];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function reconcile(summary: Summary, expected: HistoricalInput['expected'], label: string): void {
  for (const field of ['receivedCents', 'netCents', 'discountCents', 'feeCents', 'pendingCents', 'barterUnits', 'giftUnits'] as const) {
    requireCondition(summary[field] === expected[field], `${label}: ${field} diverge da planilha salva.`);
  }
  const actualOwners = Object.fromEntries(summary.byOwner.map(owner => [owner.name, owner.netCents]));
  for (const owner of new Set([...Object.keys(actualOwners), ...Object.keys(expected.byOwner)])) {
    requireCondition((actualOwners[owner] ?? 0) === (expected.byOwner[owner] ?? 0), `${label}: parte de ${owner} divergente.`);
  }
  for (const payment of summary.byPayment) {
    requireCondition(payment.totalCents === expected.byPayment[payment.method as keyof typeof expected.byPayment], `${label}: ${payment.method} divergente.`);
  }
}

// Uma migração inicial com repetição segura. Não é sincronização com uma planilha ainda em uso.
export function importHistory(db: Database.Database, untrustedInput: unknown, options: { reconcileStock?: boolean } = {}) {
  const input = historySchema.parse(untrustedInput);
  return db.transaction(() => {
    const register = new CashRegister(db);
    const records = [
      ...input.rows.map(row => ({ key: `Vendas:${row.rowNumber}`, hash: hash(row) })),
      ...input.closedDays.map(day => ({ key: `Histórico:${day.date}`, hash: hash(day) }))
    ];
    requireCondition(new Set(records.map(record => record.key)).size === records.length, 'Há linhas ou fechamentos duplicados na origem.');
    requireCondition(new Set(input.products.map(product => product.name)).size === input.products.length, 'Há produtos duplicados na origem.');
    const existing = db.prepare('SELECT record_key, payload_hash FROM spreadsheet_records WHERE source_key=?').all(input.sourceKey) as { record_key: string; payload_hash: string }[];
    if (existing.length) {
      requireCondition(existing.length === records.length && records.every(record => existing.some(saved => saved.record_key === record.key && saved.payload_hash === record.hash)),
        'A planilha mudou desde a migração. Reimportação recusada para preservar pedidos, fechamentos e estoque.');
      return { importedOrders: 0, importedRows: 0, importedClosedDays: 0, reconciledProducts: 0, alreadyImported: true };
    }
    requireCondition(register.fairId === 1 && register.fairs().length === 1 && !register.fair().closedAt,
      'A migração inicial da planilha precisa ocorrer antes de encerrar ou criar outra feira.');

    const products = register.products();
    const matchProduct = (productName: string) => {
      const matches = products.filter(product => product.name === productName);
      requireCondition(matches.length === 1, `Produto ausente ou ambíguo no cadastro: ${productName}.`);
      return matches[0]!;
    };
    const nativeSales = register.sales();
    const stockChanges: { id: number; before: number; after: number }[] = [];
    // O seed usou o saldo da planilha: ele já inclui as saídas históricas.
    // A diferença permitida vem das saídas e contagens realizadas no aplicativo.
    for (const sourceProduct of input.products) {
      const product = matchProduct(sourceProduct.name);
      const adjustments = db.prepare('SELECT before_stock, after_stock FROM stock_adjustments WHERE product_id=? ORDER BY id').all(product.id) as { before_stock: number | null; after_stock: number | null }[];
      let baseline = sourceProduct.stock;
      for (const adjustment of adjustments) {
        if (adjustment.before_stock === null || adjustment.after_stock === null) {
          requireCondition(false, `Contagem mudou entre conhecida e desconhecida: ${product.name}. Confira o saldo antes de migrar.`);
        }
        if (baseline !== null) baseline += adjustment.after_stock - adjustment.before_stock;
      }
      const consumed = nativeSales.filter(sale => sale.origin === 'Aplicativo' && sale.status === 'Pago')
        .flatMap(sale => sale.items).filter(item => item.productId === product.id).reduce((sum, item) => sum + item.quantity, 0);
      const expectedStock = baseline === null ? null : baseline - consumed;
      if (product.stock !== expectedStock) {
        requireCondition(!options.reconcileStock || adjustments.length === 0,
          `Estoque de ${product.name}: há contagem manual sem vínculo com o snapshot da planilha. Confira o saldo; conciliação automática recusada.`);
        requireCondition(options.reconcileStock && product.stock !== null && expectedStock !== null && expectedStock >= 0 && expectedStock <= 1_000_000,
          `Estoque de ${product.name} não corresponde ao saldo da planilha mais os movimentos do aplicativo. Nada foi importado.`);
        stockChanges.push({ id: product.id, before: product.stock, after: expectedStock });
      }
    }
    for (const row of input.rows) {
      requireCondition(input.products.some(product => product.name === row.name), `Produto da venda ausente no saldo: ${row.name}.`);
      const closed = db.prepare('SELECT closed_at FROM days WHERE fair_id=? AND date=?').get(register.fairId, row.date) as { closed_at: string | null } | undefined;
      requireCondition(!closed?.closed_at, `O dia ${row.date} já está fechado no aplicativo. O histórico não foi alterado.`);
    }
    for (const day of input.closedDays) {
      requireCondition(!db.prepare('SELECT date FROM days WHERE fair_id=? AND date=?').get(register.fairId, day.date), `Já existe um registro de caixa em ${day.date}. O fechamento foi preservado.`);
    }

    const groups = new Map<string, HistoricalRow[]>();
    for (const row of input.rows) {
      const key = JSON.stringify(row.orderRef ? [row.date, row.orderRef] : [row.rowNumber]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const importedAt = new Date().toISOString();
    const historicalSales: Sale[] = [];
    const insertRecord = db.prepare(`INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,day_date,source_sha256,imported_at,fair_id) VALUES(?,?,?,?,?,?,?,?)`);
    const insertItem = db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,owner_id,owner_name,quantity,price_cents,discount_cents,fee_cents,gross_cents,total_cents,net_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const rows of groups.values()) {
      const first = rows[0]!;
      requireCondition(rows.length <= 100 && rows.every(row => row.paymentMethod === first.paymentMethod && row.status === first.status), `Pedido ${first.orderRef}: situação ou pagamento incompatível.`);
      requireCondition(new Set(rows.map(row => row.name)).size === rows.length, `Pedido ${first.orderRef}: produto repetido. Confira o agrupamento.`);
      requireCondition(!isNonCash(first.paymentMethod) || first.status !== 'Pendente', 'Permuta ou brinde pendente na origem.');
      const note = [...new Set(rows.map(row => row.note).filter(Boolean))].join('\n');
      requireCondition(note.length <= 500, 'Observações do pedido excedem 500 caracteres.');
      const items = rows.map(row => {
        const currentProduct = matchProduct(row.name);
        db.prepare('INSERT INTO owners(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(row.ownerName);
        const owner = db.prepare('SELECT id FROM owners WHERE name=?').get(row.ownerName) as { id: number };
        const item = calculateItem({ ...currentProduct, name: row.name, ownerId: owner.id, ownerName: row.ownerName, priceCents: row.priceCents, active: true },
          { productId: currentProduct.id, quantity: row.quantity, expectedPriceCents: row.priceCents, discountCents: row.discountCents, feeCents: row.feeCents }, row.paymentMethod);
        requireCondition(row.totalCents === (row.status === 'Cancelado' ? 0 : item.totalCents) && row.netCents === (row.status === 'Cancelado' ? 0 : item.netCents), `Vendas, linha ${row.rowNumber}: valores salvos divergentes.`);
        return item;
      });
      const sum = (key: 'grossCents' | 'discountCents' | 'feeCents' | 'totalCents' | 'netCents') => items.reduce((total, item) => total + item[key], 0);
      const sale: Sale = { id: randomUUID(), fairId: register.fairId, date: first.date, paymentDate: first.status === 'Pago' ? first.date : null,
        paymentMethod: first.paymentMethod, status: first.status, note, createdAt: importedAt, origin: 'Planilha', items,
        automaticFees: false, cardEntry: null, feeCorrected: false,
        grossCents: sum('grossCents'), discountCents: sum('discountCents'), feeCents: sum('feeCents'), totalCents: sum('totalCents'), netCents: sum('netCents') };
      db.prepare('INSERT INTO sales(id,request_hash,date,payment_date,payment_method,status,note,created_at,fair_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(sale.id, hash(rows), sale.date, sale.paymentDate, sale.paymentMethod, sale.status, sale.note, importedAt, register.fairId);
      for (const item of items) insertItem.run(sale.id, item.productId, item.name, item.ownerId, item.ownerName, item.quantity, item.priceCents,
        item.discountCents, item.feeCents, item.grossCents, item.totalCents, item.netCents);
      for (const row of rows) insertRecord.run(input.sourceKey, `Vendas:${row.rowNumber}`, hash(row), sale.id, null, input.sha256, importedAt, register.fairId);
      historicalSales.push(sale);
    }
    reconcile(summarize(historicalSales, register.owners()), input.expected, 'Total histórico');
    for (const closing of input.closedDays) {
      const summary = register.summary(closing.date);
      reconcile(summary, closing.expected, `Fechamento de ${closing.date}`);
      const expectedCents = closing.cash.openingCents + closing.cash.extraCents - closing.cash.withdrawalCents + summary.byPayment[0]!.totalCents;
      const differenceCents = closing.cash.countedCents === null ? null : closing.cash.countedCents - expectedCents;
      requireCondition(closing.expectedCents === null || closing.expectedCents === expectedCents, `Dinheiro esperado divergente em ${closing.date}.`);
      requireCondition(closing.differenceCents === null || closing.differenceCents === differenceCents, `Contagem divergente em ${closing.date}.`);
      const throughId = register.latestFeeCorrectionId();
      const day: Day = { ...closing.cash, date: closing.date, summary, expectedCents, differenceCents, closedAt: importedAt,
        ...(throughId ? { feeCorrectionsThroughId: throughId } : {}) };
      db.prepare('INSERT INTO days(fair_id,date,opening_cents,extra_cents,withdrawal_cents,counted_cents,note,closed_at,snapshot) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(register.fairId, day.date, day.openingCents, day.extraCents, day.withdrawalCents, day.countedCents, day.note, importedAt, JSON.stringify(day));
      insertRecord.run(input.sourceKey, `Histórico:${day.date}`, hash(closing), null, day.date, input.sha256, importedAt, register.fairId);
    }
    for (const change of stockChanges) {
      db.prepare('UPDATE products SET stock=?,version=version+1 WHERE id=?').run(change.after,change.id);
      db.prepare('INSERT INTO stock_adjustments(product_id,before_stock,after_stock,reason,created_at) VALUES(?,?,?,?,?)')
        .run(change.id,change.before,change.after,'Conciliação inicial do saldo salvo na planilha',importedAt);
    }
    const firstDate = [...input.rows.map(row => row.date),...input.closedDays.map(day => day.date)].sort()[0]!;
    db.prepare('UPDATE fairs SET start_date=MIN(start_date,?) WHERE id=?').run(firstDate,register.fairId);
    return { importedOrders: historicalSales.length, importedRows: input.rows.length, importedClosedDays: input.closedDays.length,
      reconciledProducts: stockChanges.length, alreadyImported: false };
  }).immediate();
}
