import { calculatePaymentFees, paymentMethods, type CardEntry, type Product, type Sale, type SaleItem, type SaleItemInput, type PaymentMethod, type Owner, type Summary } from '@caixa/shared';
import { requireCondition } from './validation.js';

export function isNonCash(method: PaymentMethod): boolean {
  return method === 'Permuta' || method === 'Não cobrado';
}

// Os descontos e taxas pertencem ao item, exatamente como na planilha.
export function calculateItem(product: Product, input: SaleItemInput, method: PaymentMethod): SaleItem {
  requireCondition(product.active, `Produto inativo: ${product.name}`);
  requireCondition(product.priceCents === input.expectedPriceCents, `O preço de ${product.name} mudou. Atualize o pedido.`);
  requireCondition((input.expectedName === undefined || product.name === input.expectedName)
    && (input.expectedOwnerId === undefined || product.ownerId === input.expectedOwnerId)
    && (input.expectedOwnerName === undefined || product.ownerName === input.expectedOwnerName),
    `O cadastro de ${product.name} mudou. Confira nome e participante antes de atualizar o pedido.`);
  const grossCents = product.priceCents * input.quantity;
  requireCondition(input.discountCents <= grossCents, `Desconto maior que o valor de ${product.name}.`, 400);
  const chargedCents = grossCents - input.discountCents;
  requireCondition(input.feeCents <= chargedCents, `Taxa maior que o valor de ${product.name}.`, 400);
  requireCondition(!isNonCash(method) || (input.discountCents === 0 && input.feeCents === 0), 'Permutas e brindes não recebem desconto ou taxa.', 400);
  const totalCents = isNonCash(method) ? 0 : chargedCents;
  return { ...input, name: product.name, ownerId: product.ownerId, ownerName: product.ownerName,
    priceCents: product.priceCents, grossCents, totalCents, netCents: totalCents - input.feeCents };
}

export function summarize(sales: Sale[], owners: Owner[], date?: string): Summary {
  const summary: Summary = { receivedCents: 0, netCents: 0, discountCents: 0, feeCents: 0,
    pendingCents: 0, paidCount: 0, barterUnits: 0, giftUnits: 0,
    byOwner: owners.map(owner => ({ ownerId: owner.id, name: owner.name, receivedCents: 0, feeCents: 0, netCents: 0 })),
    byPayment: paymentMethods.slice(0, 4).map(method => ({ method, totalCents: 0 })) };
  for (const sale of sales) {
    if (sale.status === 'Pendente' && (!date || sale.date === date)) summary.pendingCents += sale.totalCents;
    if (sale.status !== 'Pago' || (date && sale.paymentDate !== date)) continue;
    summary.paidCount++;
    const units = sale.items.reduce((sum, item) => sum + item.quantity, 0);
    if (sale.paymentMethod === 'Permuta') { summary.barterUnits += units; continue; }
    if (sale.paymentMethod === 'Não cobrado') { summary.giftUnits += units; continue; }
    summary.receivedCents += sale.totalCents;
    summary.netCents += sale.netCents;
    summary.discountCents += sale.discountCents;
    summary.feeCents += sale.feeCents;
    const payment = summary.byPayment.find(entry => entry.method === sale.paymentMethod)!;
    payment.totalCents += sale.totalCents;
    for (const item of sale.items) {
      let owner = summary.byOwner.find(entry => entry.ownerId === item.ownerId);
      if (!owner) { owner = { ownerId: item.ownerId, name: item.ownerName, receivedCents: 0, feeCents: 0, netCents: 0 }; summary.byOwner.push(owner); }
      owner.receivedCents += item.totalCents;
      owner.feeCents += item.feeCents;
      owner.netCents += item.netCents;
    }
  }
  return summary;
}

export function applyPaymentFees(items: SaleItem[], method: PaymentMethod, entry: CardEntry | null): SaleItem[] {
  const fees = calculatePaymentFees(items.map(item => item.totalCents), method, entry);
  return items.map((item, index) => ({ ...item, feeCents: fees[index], netCents: item.totalCents - fees[index] }));
}
