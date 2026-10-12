import type { Sale } from '@caixa/shared';

export interface ProductAmounts {
  quantity: number; receivedCents: number; feeCents: number; netCents: number;
}
export interface ProductSummary extends ProductAmounts {
  key: string; ownerId: number; name: string; ownerName: string; byDate: Map<string, ProductAmounts>;
}

// Usa o mesmo dia de recebimento e os mesmos valores históricos do fechamento.
// As parcelas de um pagamento misto não duplicam produtos nem quantidades.
export function summarizeProducts(sales: Sale[], dates: readonly string[]): ProductSummary[] {
  const closedDates = new Set(dates);
  const products = new Map<string, ProductSummary>();
  for (const sale of sales) {
    if (sale.status !== 'Pago' || !sale.paymentDate || !closedDates.has(sale.paymentDate)
      || sale.paymentMethod === 'Permuta' || sale.paymentMethod === 'Não cobrado') continue;
    for (const item of sale.items) {
      // Um produto que mudou de participante conserva a atribuição de cada venda.
      const key = `${item.productId}:${item.ownerId}`;
      let product = products.get(key);
      if (!product) {
        product = { key, ownerId: item.ownerId, name: item.name, ownerName: item.ownerName, quantity: 0, receivedCents: 0, feeCents: 0, netCents: 0, byDate: new Map() };
        products.set(key, product);
      }
      const day = product.byDate.get(sale.paymentDate) ?? { quantity: 0, receivedCents: 0, feeCents: 0, netCents: 0 };
      day.quantity += item.quantity; day.receivedCents += item.totalCents;
      day.feeCents += item.feeCents; day.netCents += item.netCents;
      product.byDate.set(sale.paymentDate, day);
      product.quantity += item.quantity; product.receivedCents += item.totalCents;
      product.feeCents += item.feeCents; product.netCents += item.netCents;
    }
  }
  return [...products.values()].sort((a, b) => b.quantity - a.quantity || b.netCents - a.netCents || a.name.localeCompare(b.name, 'pt-BR'));
}
