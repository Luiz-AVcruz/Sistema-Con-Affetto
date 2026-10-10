import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { paymentMethods, type PaymentMethod, type Sale } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney } from '../../core/money';

@Component({ selector: 'app-history', standalone: true, imports: [FormsModule], templateUrl: './history.component.html' })
export class HistoryComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly allDates = signal(false);
  readonly methods = paymentMethods.slice(0, 4);
  readonly receiptMethods: Record<string, PaymentMethod> = {};
  readonly sales = computed(() => (this.store.data()?.sales ?? []).filter(sale => this.allDates() || sale.date === this.store.date() || sale.paymentDate === this.store.date() || sale.status === 'Pendente'));
  async cancel(sale: Sale): Promise<void> {
    if (confirm(`Cancelar o pedido de ${formatMoney(sale.totalCents)}? Se estava pago, a quantidade será devolvida ao estoque. Confirme que os produtos realmente voltaram.`)) await this.store.cancel(sale.id);
  }
  receive(sale: Sale) { return this.store.receive(sale.id, this.receiptMethods[sale.id] ?? sale.paymentMethod); }
  paymentClosed(sale: Sale): boolean { return (this.store.data()?.closedDays ?? []).some(day => day.date === sale.paymentDate); }
}
