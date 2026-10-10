import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { CashRegister } from './cash-register.js';
import { historySchema, type HistoricalInput } from './historical-import.js';
import { requireCondition, saleSchema } from './validation.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Row = HistoricalInput['rows'][number];

// Conciliação explícita de vendas acrescentadas depois da migração inicial.
// Nunca altera os registros anteriores nem reutiliza o saldo inicial do seed.
export function appendHistory(db: Database.Database, untrustedInput: unknown) {
  const input = historySchema.parse(untrustedInput);
  return db.transaction(() => {
    const register = new CashRegister(db);
    const records = new Map<string, string>([
      ...input.rows.map(row => [`Vendas:${row.rowNumber}`, hash(row)] as const),
      ...input.closedDays.map(day => [`Histórico:${day.date}`, hash(day)] as const)
    ]);
    requireCondition(records.size === input.rows.length + input.closedDays.length, 'Há registros duplicados na origem.');
    requireCondition(new Set(input.products.map(product => product.name)).size === input.products.length, 'Há produtos duplicados na origem.');
    const existing = db.prepare('SELECT record_key,payload_hash,fair_id FROM spreadsheet_records WHERE source_key=?')
      .all(input.sourceKey) as { record_key: string; payload_hash: string; fair_id: number }[];
    requireCondition(existing.length > 0, 'Faça a importação inicial antes de acrescentar vendas.');
    requireCondition(existing.every(record => record.fair_id === 1 && records.get(record.record_key) === record.payload_hash),
      'Um registro anterior da planilha mudou ou foi removido. Nenhuma venda foi acrescentada.');
    const savedKeys = new Set(existing.map(record => record.record_key));
    requireCondition(input.closedDays.every(day => savedKeys.has(`Histórico:${day.date}`)),
      'Novos fechamentos da planilha exigem conferência separada. Nenhuma venda foi acrescentada.');
    const newRows = input.rows.filter(row => !savedKeys.has(`Vendas:${row.rowNumber}`));
    if (!newRows.length) return { importedOrders: 0, importedRows: 0, importedClosedDays: 0, reconciledProducts: 0, alreadyImported: true };
    requireCondition(register.fairId === 1 && register.fairs().length === 1 && !register.fair().closedAt,
      'Acrescente as vendas antes de encerrar a primeira feira.');
    const lastRow = Math.max(...existing.filter(record => record.record_key.startsWith('Vendas:')).map(record => Number(record.record_key.slice(7))));
    requireCondition(newRows.every(row => row.rowNumber > lastRow), 'Só é permitido acrescentar linhas depois das vendas já importadas.');
    const oldRows = input.rows.filter(row => savedKeys.has(`Vendas:${row.rowNumber}`));
    requireCondition(newRows.every(row => !row.orderRef || !oldRows.some(old => old.date === row.date && old.orderRef === row.orderRef)),
      'Uma linha nova não pode acrescentar itens a um pedido já importado.');
    requireCondition(newRows.every(row => row.status !== 'Cancelado'), 'Pedidos já cancelados na origem exigem conferência separada.');

    const catalog = register.products();
    const groups = new Map<string, Row[]>();
    for (const row of newRows) {
      const key = JSON.stringify(row.orderRef ? [row.date, row.orderRef] : [row.rowNumber]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const importedAt = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO spreadsheet_records(source_key,record_key,payload_hash,sale_id,day_date,source_sha256,imported_at,fair_id)
      VALUES(?,?,?,?,NULL,?,?,?)`);
    for (const rows of groups.values()) {
      const first = rows[0]!;
      requireCondition(rows.every(row => row.paymentMethod === first.paymentMethod && row.status === first.status), 'Pagamento ou situação incompatível no pedido novo.');
      const items = rows.map(row => {
        const matches = catalog.filter(product => product.name === row.name);
        requireCondition(matches.length === 1, `Produto ausente ou ambíguo: ${row.name}.`);
        const product = matches[0]!;
        requireCondition(product.ownerName === row.ownerName && product.priceCents === row.priceCents,
          `Preço ou participante de ${row.name} difere do cadastro atual. Confira antes de acrescentar a venda.`);
        return { productId: product.id, quantity: row.quantity, expectedPriceCents: row.priceCents, discountCents: row.discountCents, feeCents: row.feeCents };
      });
      const sale = register.createSale(saleSchema.parse({ requestId: randomUUID(), fairId: 1, date: first.date,
        paymentMethod: first.paymentMethod, status: first.status,
        note: [...new Set(rows.map(row => row.note).filter(Boolean))].join('\n'), items }));
      for (const row of rows) {
        const item = sale.items.find(item => item.name === row.name)!;
        requireCondition(item.totalCents === row.totalCents && item.netCents === row.netCents,
          `Valores salvos divergentes em Vendas:${row.rowNumber}. Nada foi acrescentado.`);
        insert.run(input.sourceKey, `Vendas:${row.rowNumber}`, hash(row), sale.id, input.sha256, importedAt, register.fairId);
      }
    }
    // A transação só confirma se o caixa inteiro e o saldo final conciliam.
    const summary = register.summary();
    for (const field of ['receivedCents', 'netCents', 'discountCents', 'feeCents', 'pendingCents', 'barterUnits', 'giftUnits'] as const) {
      requireCondition(summary[field] === input.expected[field], `Total ${field} diverge da planilha. Nenhuma venda foi acrescentada.`);
    }
    for (const name of new Set([...summary.byOwner.map(owner => owner.name), ...Object.keys(input.expected.byOwner)])) {
      requireCondition((summary.byOwner.find(owner => owner.name === name)?.netCents ?? 0) === (input.expected.byOwner[name] ?? 0),
        `Parte de ${name} diverge da planilha. Nenhuma venda foi acrescentada.`);
    }
    for (const payment of summary.byPayment) requireCondition(payment.totalCents === input.expected.byPayment[payment.method as keyof typeof input.expected.byPayment],
      `Total de ${payment.method} diverge da planilha. Nenhuma venda foi acrescentada.`);
    const after = register.products();
    requireCondition(input.products.length === after.length && input.products.every(source => {
      const matches = after.filter(product => product.name === source.name);
      return matches.length === 1 && matches[0]!.stock === source.stock;
    }), 'O estoque final diverge da planilha. Confira contagens ou movimentos das duas fontes; nenhuma venda foi acrescentada.');
    return { importedOrders: groups.size, importedRows: newRows.length, importedClosedDays: 0, reconciledProducts: 0, alreadyImported: false };
  }).immediate();
}
