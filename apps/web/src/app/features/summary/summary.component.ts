import { Component, computed, inject, output, signal } from '@angular/core';
import type { Day, Summary } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, formatRegisteredAt } from '../../core/money';
import { DaySummaryComponent } from '../closing/day-summary.component';
import { summarizeProducts } from './product-summary';

@Component({ selector: 'app-summary', standalone: true, imports: [DaySummaryComponent], templateUrl: './summary.component.html' })
export class SummaryComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly registeredLabel = formatRegisteredAt;
  readonly showHistory = output<string>();
  private readonly selection = signal<{ fairId: number; date: string } | null>(null);
  readonly closedDays = computed(() => [...(this.store.data()?.closedDays ?? [])].sort((a, b) => b.date.localeCompare(a.date)));
  readonly comparisonDays = computed(() => [...this.closedDays()].reverse());
  readonly products = computed(() => summarizeProducts(this.store.data()?.sales ?? [], this.closedDays().map(day => day.date)));
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
    const owners = new Map<number, { ownerId: number; name: string; netCents: number; byDate: Map<string, Summary['byOwner'][number]> }>();
    for (const day of this.closedDays()) {
      for (const amounts of (day.adjustedSummary ?? day.summary).byOwner) {
        const owner = owners.get(amounts.ownerId) ?? { ownerId: amounts.ownerId, name: amounts.name, netCents: 0, byDate: new Map() };
        owner.netCents += amounts.netCents; owner.byDate.set(day.date, amounts);
        owners.set(owner.ownerId, owner);
      }
    }
    return [...owners.values()].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'pt-BR'));
  });

  selectDay(date: string): void {
    const fairId = this.store.data()?.fair.id;
    if (fairId !== undefined && this.closedDays().some(day => day.date === date)) this.selection.set({ fairId, date });
  }
}
