import { Component, computed, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Summary } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, localDate, parseMoney } from '../../core/money';

@Component({ selector: 'app-fairs', standalone: true, imports: [FormsModule], templateUrl: './fairs.component.html' })
export class FairsComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly activeFairId = computed(() => this.store.data()?.activeFairId ?? null);
  readonly pendingCount = computed(() => this.store.data()?.sales.filter(sale => sale.status === 'Pendente').length ?? 0);
  readonly latestFairDate = computed(() => {
    const data = this.store.data();
    if (!data) return this.store.date();
    const dates = [data.fair.startDate, this.store.date(), data.day.date,
      ...data.sales.flatMap(sale => [sale.date, ...(sale.paymentDate ? [sale.paymentDate] : [])]),
      ...data.closedDays.map(day => day.date)];
    return dates.sort().at(-1)!;
  });

  editName = '';
  editTarget = '';
  closeDate = this.store.date();
  newName = '';
  newTarget = '';
  newStartDate = localDate();
  private loadedFairId: number | null = null;

  constructor() {
    effect(() => {
      const fair = this.store.data()?.fair;
      if (!fair || fair.id === this.loadedFairId) return;
      this.loadedFairId = fair.id;
      this.editName = fair.name;
      this.editTarget = fair.targetCents === null ? '' : (fair.targetCents / 100).toFixed(2).replace('.', ',');
      this.closeDate = this.latestFairDate();
    });
    effect(() => {
      const minDate = this.latestFairDate();
      if (this.closeDate < minDate) this.closeDate = minDate;
    });
  }

  progress(netCents: number, targetCents: number | null): number {
    return targetCents === null ? 0 : Math.min(100, Math.floor(netCents * 100 / targetCents));
  }
  companyNet(summary: Summary): number { return summary.byOwner.find(owner => owner.name === 'Con Affetto')?.netCents ?? 0; }

  async save(): Promise<void> {
    try {
      const targetCents = this.editTarget.trim() ? parseMoney(this.editTarget) : null;
      if (targetCents !== null && targetCents <= 0) throw new Error('A meta deve ser maior que zero.');
      if (!this.editName.trim()) throw new Error('Informe o nome da feira.');
      await this.store.saveFair({ name: this.editName.trim(), targetCents });
    } catch (error) { this.store.report(error); }
  }

  async create(): Promise<void> {
    try {
      const targetCents = this.newTarget.trim() ? parseMoney(this.newTarget) : null;
      if (targetCents !== null && targetCents <= 0) throw new Error('A meta deve ser maior que zero.');
      if (!this.newName.trim()) throw new Error('Informe o nome da feira.');
      const created = await this.store.createFair({ name: this.newName.trim(), targetCents, startDate: this.newStartDate });
      if (created) { this.newName = ''; this.newTarget = ''; this.newStartDate = localDate(); }
    } catch (error) { this.store.report(error); }
  }

  async close(): Promise<void> {
    const fair = this.store.data()?.fair;
    if (!fair || fair.closedAt) return;
    if (this.pendingCount() > 0) {
      this.store.error.set(`Ainda há ${this.pendingCount()} pedido(s) pendente(s). Receba ou cancele todos antes de encerrar a feira.`);
      return;
    }
    const confirmMessage = `Encerrar “${fair.name}” em ${formatDay(this.closeDate)}? A feira ficará apenas para consulta. Os dias em aberto serão fechados usando as conferências que já foram salvas.`;
    if (!confirm(confirmMessage)) return;
    await this.store.closeFair(this.closeDate);
  }
}
