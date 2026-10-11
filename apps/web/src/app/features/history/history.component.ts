import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { paymentMethods, type PaymentMethod, type Sale } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, formatRegisteredAt } from '../../core/money';

const preferencesKey = 'caixa-feira-history-preferences-v1';
const orderOptions = [
  { value: 'date-desc', label: 'Mais recentes primeiro' },
  { value: 'date-asc', label: 'Mais antigos primeiro' },
  { value: 'value-desc', label: 'Maior valor primeiro' },
  { value: 'value-asc', label: 'Menor valor primeiro' }
] as const;
type HistoryOrder = typeof orderOptions[number]['value'];
interface HistoryPreferences { allDates: boolean; order: HistoryOrder }

@Component({ selector: 'app-history', standalone: true, imports: [FormsModule], templateUrl: './history.component.html' })
export class HistoryComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly registeredLabel = formatRegisteredAt;
  private readonly preferences = this.loadPreferences();
  readonly allDates = signal(this.preferences.allDates);
  readonly order = signal(this.preferences.order);
  readonly orderOptions = orderOptions;
  readonly methods = paymentMethods.slice(0, 4);
  readonly receiptMethods: Record<string, PaymentMethod> = {};
  readonly deleteConfirmation = signal<{ sale: Sale; fairId: number } | null>(null);
  readonly closedDates = computed(() => {
    const data = this.store.data();
    const dates = new Set((data?.closedDays ?? []).map(day => day.date));
    if (data?.day.closedAt) dates.add(data.day.date);
    return dates;
  });
  readonly sales = computed(() => {
    const sales = (this.store.data()?.sales ?? []).filter(sale => this.allDates() || sale.date === this.store.date() || sale.paymentDate === this.store.date());
    const byDate = (a: Sale, b: Sale) => a.date.localeCompare(b.date)
      || (a.origin === 'Planilha' ? '' : a.createdAt).localeCompare(b.origin === 'Planilha' ? '' : b.createdAt);
    switch (this.order()) {
      case 'date-asc': return sales.sort(byDate);
      case 'value-desc': return sales.sort((a, b) => b.totalCents - a.totalCents || byDate(b, a));
      case 'value-asc': return sales.sort((a, b) => a.totalCents - b.totalCents || byDate(b, a));
      default: return sales.sort((a, b) => byDate(b, a));
    }
  });
  constructor() {
    effect(() => {
      const confirmation = this.deleteConfirmation();
      const selectedFairId = this.store.data()?.fair.id ?? this.store.selectedFairId();
      if (confirmation && confirmation.fairId !== selectedFairId) this.deleteConfirmation.set(null);
    });
  }
  private loadPreferences(): HistoryPreferences {
    const defaults: HistoryPreferences = { allDates: false, order: 'date-desc' };
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? 'null');
      if (!saved || typeof saved !== 'object') return defaults;
      const preferences = saved as { allDates?: unknown; order?: unknown };
      return {
        allDates: typeof preferences.allDates === 'boolean' ? preferences.allDates : defaults.allDates,
        order: orderOptions.some(option => option.value === preferences.order) ? preferences.order as HistoryOrder : defaults.order
      };
    } catch { return defaults; }
  }
  private savePreferences(): void {
    try { localStorage.setItem(preferencesKey, JSON.stringify({ allDates: this.allDates(), order: this.order() })); }
    catch { /* Preferências opcionais: a consulta continua funcionando nesta sessão. */ }
  }
  setAllDates(value: boolean): void { this.allDates.set(value); this.savePreferences(); }
  setOrder(value: HistoryOrder): void { this.order.set(value); this.savePreferences(); }
  async cancel(sale: Sale): Promise<void> {
    if (confirm(`Cancelar o pedido de ${formatMoney(sale.totalCents)}? Se estava pago, a quantidade será devolvida ao estoque. Confirme que os produtos realmente voltaram.`)) await this.store.cancel(sale.id);
  }
  closedDay(sale: Sale): string | null {
    const dates = this.closedDates();
    if (dates.has(sale.date)) return sale.date;
    if (sale.paymentDate && dates.has(sale.paymentDate)) return sale.paymentDate;
    return null;
  }
  deleteBlockedReason(sale: Sale): string | null {
    if (this.store.data()?.fair.closedAt) return 'Feira encerrada';
    const date = this.closedDay(sale);
    return date ? `Dia ${this.dayLabel(date)} fechado` : null;
  }
  openDeleteConfirmation(sale: Sale): void {
    const fair = this.store.data()?.fair;
    if (!fair || this.deleteBlockedReason(sale)) return;
    this.deleteConfirmation.set({ sale, fairId: fair.id });
  }
  closeDeleteConfirmation(): void { this.deleteConfirmation.set(null); }
  async confirmDelete(): Promise<void> {
    const confirmation = this.deleteConfirmation();
    if (!confirmation) return;
    if (confirmation.fairId !== this.store.data()?.fair.id || this.deleteBlockedReason(confirmation.sale)) {
      this.deleteConfirmation.set(null);
      this.store.error.set('A feira ou o fechamento mudou. Confira novamente o histórico antes de excluir.');
      return;
    }
    if (await this.store.deleteSale(confirmation.sale.id, confirmation.fairId)) this.deleteConfirmation.set(null);
  }
  receive(sale: Sale) { return this.store.receive(sale.id, this.receiptMethods[sale.id] ?? sale.paymentMethod); }
  paymentClosed(sale: Sale): boolean { return (this.store.data()?.closedDays ?? []).some(day => day.date === sale.paymentDate); }
}
