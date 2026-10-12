import type { Day } from '@caixa/shared';
import { formatDay } from '../../core/money';
import type { ProductAmounts } from './product-summary';

export const comparisonTargets = [
  { value: 'both', label: 'Produtos e participantes' },
  { value: 'products', label: 'Produtos' },
  { value: 'owners', label: 'Participantes' }
] as const;
export const comparisonGroupings = [
  { value: 'day', label: 'Por dia' }, { value: 'week', label: 'Por semana' }
] as const;
export const comparisonMetrics = [
  { value: 'units-net', label: 'Unidades e líquido' }, { value: 'units', label: 'Unidades vendidas' },
  { value: 'received', label: 'Bruto recebido' }, { value: 'net', label: 'Líquido recebido' }, { value: 'fees', label: 'Taxas de pagamento' }
] as const;
export const comparisonOrders = [
  { value: 'units-desc', label: 'Mais unidades primeiro' }, { value: 'units-asc', label: 'Menos unidades primeiro' },
  { value: 'net-desc', label: 'Maior líquido primeiro' }, { value: 'net-asc', label: 'Menor líquido primeiro' }
] as const;
export interface ComparisonPreferences {
  dates: string[] | null; ownerIds: number[] | null; productKeys: string[] | null;
  target: typeof comparisonTargets[number]['value']; grouping: typeof comparisonGroupings[number]['value'];
  metric: typeof comparisonMetrics[number]['value']; order: typeof comparisonOrders[number]['value']; showEmpty: boolean;
}
export interface ComparisonPeriod { key: string; label: string; dates: string[] }

export function comparisonPreferencesKey(fairId: number): string { return `caixa-feira-comparisons-v1-${fairId}`; }
export function loadComparisonPreferences(fairId: number): ComparisonPreferences {
  const defaults: ComparisonPreferences = { dates: null, ownerIds: null, productKeys: null,
    target: 'both', grouping: 'day', metric: 'units-net', order: 'units-desc', showEmpty: false };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(comparisonPreferencesKey(fairId)) ?? 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults;
    const values = saved as Record<string, unknown>;
    return {
      dates: Array.isArray(values['dates']) && values['dates'].every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? values['dates'] : null,
      ownerIds: Array.isArray(values['ownerIds']) && values['ownerIds'].every(value => Number.isSafeInteger(value) && value > 0) ? values['ownerIds'] : null,
      productKeys: Array.isArray(values['productKeys']) && values['productKeys'].every(value => typeof value === 'string') ? values['productKeys'] : null,
      target: comparisonTargets.some(option => option.value === values['target']) ? values['target'] as ComparisonPreferences['target'] : defaults.target,
      grouping: comparisonGroupings.some(option => option.value === values['grouping']) ? values['grouping'] as ComparisonPreferences['grouping'] : defaults.grouping,
      metric: comparisonMetrics.some(option => option.value === values['metric']) ? values['metric'] as ComparisonPreferences['metric'] : defaults.metric,
      order: comparisonOrders.some(option => option.value === values['order']) ? values['order'] as ComparisonPreferences['order'] : defaults.order,
      showEmpty: typeof values['showEmpty'] === 'boolean' ? values['showEmpty'] : false
    };
  } catch { return defaults; }
}

export function hasDayActivity(day: Day, datesWithSales: ReadonlySet<string>): boolean {
  const summary = day.adjustedSummary ?? day.summary;
  return datesWithSales.has(day.date) || summary.paidCount > 0 || summary.receivedCents !== 0
    || summary.pendingCents !== 0 || summary.feeCents !== 0 || summary.netCents !== 0 || summary.discountCents !== 0
    || summary.barterUnits > 0 || summary.giftUnits > 0 || day.openingCents !== 0 || day.extraCents !== 0
    || day.withdrawalCents !== 0 || day.countedCents !== null || day.note.trim().length > 0;
}

export function comparisonPeriods(dates: readonly string[], grouping: ComparisonPreferences['grouping']): ComparisonPeriod[] {
  const periods = new Map<string, string[]>();
  for (const date of [...dates].sort()) {
    const monday = new Date(date + 'T12:00:00Z');
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const key = grouping === 'day' ? date : monday.toISOString().slice(0, 10);
    const days = periods.get(key) ?? []; days.push(date); periods.set(key, days);
  }
  return [...periods].map(([key, dates]) => ({ key, dates,
    label: dates.length === 1 ? formatDay(dates[0]!) : `${formatDay(dates[0]!)} a ${formatDay(dates.at(-1)!)}` }));
}

export function sumProductAmounts(amounts: Iterable<ProductAmounts>): ProductAmounts {
  const totals: ProductAmounts = { quantity: 0, receivedCents: 0, feeCents: 0, netCents: 0 };
  for (const value of amounts) {
    totals.quantity += value.quantity; totals.receivedCents += value.receivedCents;
    totals.feeCents += value.feeCents; totals.netCents += value.netCents;
  }
  return totals;
}
export function periodAmounts(byDate: ReadonlyMap<string, ProductAmounts>, dates: readonly string[]): ProductAmounts {
  return sumProductAmounts(dates.flatMap(date => { const value = byDate.get(date); return value ? [value] : []; }));
}
