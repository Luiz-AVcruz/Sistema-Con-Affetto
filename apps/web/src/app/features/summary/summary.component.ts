import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Day } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, formatRegisteredAt } from '../../core/money';
import { DaySummaryComponent } from '../closing/day-summary.component';
import { summarizeProducts, type ProductAmounts } from './product-summary';
import { comparisonGroupings, comparisonMetrics, comparisonOrders, comparisonTargets, comparisonPeriods,
  comparisonPreferencesKey, defaultComparisonPreferences, hasDayActivity, loadComparisonPreferences, periodAmounts, sumProductAmounts,
  type ComparisonPreferences } from './comparison';

@Component({ selector: 'app-summary', standalone: true, imports: [FormsModule, DaySummaryComponent], templateUrl: './summary.component.html' })
export class SummaryComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly registeredLabel = formatRegisteredAt;
  readonly showHistory = output<string>();
  readonly comparisonTargets = comparisonTargets;
  readonly comparisonGroupings = comparisonGroupings;
  readonly comparisonMetrics = comparisonMetrics;
  readonly comparisonOrders = comparisonOrders;
  readonly comparisonMetricsLabel = computed(() => comparisonMetrics.find(option => option.value === this.preferences().metric)!.label);
  readonly periodAmounts = periodAmounts;
  readonly preferences = signal(loadComparisonPreferences(this.store.data()!.fair.id));
  private readonly selection = signal<{ fairId: number; date: string } | null>(null);
  private readonly allClosedDays = computed(() => [...(this.store.data()?.closedDays ?? [])].sort((a, b) => b.date.localeCompare(a.date)));
  readonly closedDays = computed(() => {
    const datesWithSales = new Set((this.store.data()?.sales ?? []).flatMap(sale => [sale.date, ...(sale.paymentDate ? [sale.paymentDate] : [])]));
    return this.allClosedDays().filter(day => this.preferences().showEmpty || hasDayActivity(day, datesWithSales));
  });
  readonly hiddenEmptyDays = computed(() => this.allClosedDays().length - this.closedDays().length);
  readonly comparisonDays = computed(() => [...this.closedDays()].reverse().filter(day => this.preferences().dates === null || this.preferences().dates!.includes(day.date)));
  readonly comparisonDates = computed(() => new Set(this.comparisonDays().map(day => day.date)));
  readonly periods = computed(() => comparisonPeriods([...this.comparisonDates()], this.preferences().grouping));
  readonly products = computed(() => summarizeProducts(this.store.data()?.sales ?? [], this.allClosedDays().map(day => day.date)));
  readonly ownerChoices = computed(() => {
    const names = new Map<number, string>();
    for (const day of this.allClosedDays()) for (const owner of (day.adjustedSummary ?? day.summary).byOwner) if (!names.has(owner.ownerId)) names.set(owner.ownerId, owner.name);
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  });
  readonly selectedOwnerIds = computed(() => new Set(this.ownerChoices().filter(owner => this.preferences().ownerIds === null || this.preferences().ownerIds!.includes(owner.id)).map(owner => owner.id)));
  readonly productChoices = computed(() => this.products().filter(product => this.selectedOwnerIds().has(product.ownerId)));
  readonly selectedProductKeys = computed(() => new Set(this.productChoices().filter(product => this.preferences().productKeys === null || this.preferences().productKeys!.includes(product.key)).map(product => product.key)));
  readonly comparisonProducts = computed(() => this.productChoices().filter(product => this.selectedProductKeys().has(product.key))
    .map(product => ({ ...product, ...periodAmounts(product.byDate, [...this.comparisonDates()]) })).sort((a, b) => this.compareAmounts(a, b) || a.name.localeCompare(b.name, 'pt-BR')));
  readonly periodSummaries = computed(() => this.periods().map(period => {
    const days = this.comparisonDays().filter(day => period.dates.includes(day.date));
    const summaries = days.map(day => day.adjustedSummary ?? day.summary);
    const amounts = sumProductAmounts(this.products().map(product => periodAmounts(product.byDate, period.dates)));
    const paidCount = (this.store.data()?.sales ?? []).filter(sale => sale.status === 'Pago' && sale.paymentDate && period.dates.includes(sale.paymentDate)
      && sale.paymentMethod !== 'Permuta' && sale.paymentMethod !== 'Não cobrado').length;
    const receivedCents = summaries.reduce((sum, summary) => sum + summary.receivedCents, 0);
    return { ...period, quantity: amounts.quantity, paidCount, receivedCents, feeCents: summaries.reduce((sum, summary) => sum + summary.feeCents, 0),
      netCents: summaries.reduce((sum, summary) => sum + summary.netCents, 0), averageCents: paidCount ? Math.round(receivedCents / paidCount) : null };
  }));
  readonly selectedDay = computed<Day | null>(() => {
    const days = this.closedDays();
    const selection = this.selection();
    const date = selection && selection.fairId === this.store.data()?.fair.id ? selection.date : this.store.date();
    return days.find(day => day.date === date) ?? days[0] ?? null;
  });
  readonly selectedProducts = computed(() => {
    const date = this.selectedDay()?.date;
    if (!date) return [];
    return this.products().flatMap(product => {
      const amounts = product.byDate.get(date);
      return amounts ? [{ key: product.key, name: product.name, ownerName: product.ownerName, ...amounts }] : [];
    }).sort((a, b) => b.quantity - a.quantity || b.netCents - a.netCents || a.name.localeCompare(b.name, 'pt-BR'));
  });
  readonly owners = computed(() => {
    const owners = new Map<number, { ownerId: number; name: string; byDate: Map<string, ProductAmounts> }>();
    for (const day of this.comparisonDays()) {
      for (const amounts of (day.adjustedSummary ?? day.summary).byOwner) {
        if (!this.selectedOwnerIds().has(amounts.ownerId)) continue;
        const quantity = this.products().filter(product => product.ownerId === amounts.ownerId).reduce((sum, product) => sum + (product.byDate.get(day.date)?.quantity ?? 0), 0);
        const owner = owners.get(amounts.ownerId) ?? { ownerId: amounts.ownerId, name: amounts.name, byDate: new Map() };
        owner.byDate.set(day.date, { ...amounts, quantity });
        owners.set(owner.ownerId, owner);
      }
    }
    return [...owners.values()].map(owner => ({ ...owner, ...sumProductAmounts(owner.byDate.values()) }))
      .sort((a, b) => this.compareAmounts(a, b) || a.name.localeCompare(b.name, 'pt-BR'));
  });

  updatePreferences(changes: Partial<ComparisonPreferences>): void {
    this.preferences.update(values => ({ ...values, ...changes }));
    try { localStorage.setItem(comparisonPreferencesKey(this.store.data()!.fair.id), JSON.stringify(this.preferences())); }
    catch { /* A seleção continua funcionando nesta seção quando o armazenamento está indisponível. */ }
  }
  resetComparison(): void { this.updatePreferences(defaultComparisonPreferences()); }
  toggleDay(date: string, selected: boolean): void {
    if (!this.closedDays().some(day => day.date === date)) return;
    const dates = new Set(this.preferences().dates ?? this.allClosedDays().map(day => day.date));
    selected ? dates.add(date) : dates.delete(date);
    this.updatePreferences({ dates: [...dates].sort() });
  }
  toggleOwner(id: number, selected: boolean): void {
    const ids = new Set(this.selectedOwnerIds()); selected ? ids.add(id) : ids.delete(id);
    this.updatePreferences({ ownerIds: [...ids] });
  }
  toggleProduct(key: string, selected: boolean): void {
    const keys = new Set(this.preferences().productKeys ?? this.products().map(product => product.key));
    selected ? keys.add(key) : keys.delete(key);
    this.updatePreferences({ productKeys: [...keys] });
  }
  comparisonDisplay(amounts: ProductAmounts): { value: string; secondary: string | null } {
    const metric = this.preferences().metric;
    if (metric === 'units' || metric === 'units-net') return { value: `${amounts.quantity} un.`, secondary: metric === 'units-net' ? this.money(amounts.netCents) : null };
    return { value: this.money(metric === 'received' ? amounts.receivedCents : metric === 'fees' ? amounts.feeCents : amounts.netCents), secondary: null };
  }
  private compareAmounts(a: ProductAmounts, b: ProductAmounts): number {
    const order = this.preferences().order;
    return order === 'units-asc' ? a.quantity - b.quantity : order === 'net-desc' ? b.netCents - a.netCents
      : order === 'net-asc' ? a.netCents - b.netCents : b.quantity - a.quantity;
  }

  selectDay(date: string): void {
    const fairId = this.store.data()?.fair.id;
    if (fairId !== undefined && this.closedDays().some(day => day.date === date)) {
      this.selection.set({ fairId, date });
      document.getElementById('closed-day-summary')?.scrollIntoView({ block: 'start' });
    }
  }
}
