import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, moneyInput, parseMoney } from '../../core/money';

@Component({ selector: 'app-closing', standalone: true, imports: [FormsModule], templateUrl: './closing.component.html' })
export class ClosingComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  opening = ''; extra = ''; withdrawal = ''; counted = ''; note = '';
  constructor() {
    effect(() => {
      const day = this.store.data()?.day;
      if (!day) return;
      this.opening = moneyInput(day.openingCents); this.extra = moneyInput(day.extraCents);
      this.withdrawal = moneyInput(day.withdrawalCents); this.counted = day.countedCents === null ? '' : moneyInput(day.countedCents); this.note = day.note;
    });
  }
  preview(): { expected: number; difference: number | null } | null {
    try {
      const cash = this.store.data()?.day.summary.byPayment.find(payment => payment.method === 'Dinheiro')?.totalCents ?? 0;
      const expected = cash + parseMoney(this.opening) + parseMoney(this.extra) - parseMoney(this.withdrawal);
      return { expected, difference: this.counted.trim() ? parseMoney(this.counted) - expected : null };
    } catch { return null; }
  }
  async save(close: boolean): Promise<void> {
    try {
      const input = { openingCents: parseMoney(this.opening), extraCents: parseMoney(this.extra), withdrawalCents: parseMoney(this.withdrawal),
        countedCents: this.counted.trim() ? parseMoney(this.counted) : null, note: this.note };
      if (close && !confirm(`Fechar o dia ${formatDay(this.store.date())}? O fechamento será guardado e os recebimentos desse dia ficarão bloqueados para alteração.`)) return;
      await this.store.saveDay(input, close);
    } catch (error) { this.store.report(error); }
  }
}
