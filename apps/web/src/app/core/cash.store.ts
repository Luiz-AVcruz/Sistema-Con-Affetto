import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Bootstrap, SaleInput, ProductInput, CashInput, PaymentMethod } from '@caixa/shared';
import { localDate } from './money';

@Injectable({ providedIn: 'root' })
export class CashStore {
  private readonly http = inject(HttpClient);
  private requestSequence = 0;
  readonly data = signal<Bootstrap | null>(null);
  readonly date = signal(localDate());
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly busy = computed(() => this.loading() || this.saving());
  readonly error = signal('');
  readonly notice = signal('');

  async refresh(): Promise<void> {
    const sequence = ++this.requestSequence;
    const date = this.date();
    this.loading.set(true);
    if (this.data()?.day.date !== date) this.data.set(null);
    try {
      const data = await firstValueFrom(this.http.get<Bootstrap>('/api/bootstrap', { params: { date } }));
      if (sequence === this.requestSequence) this.data.set(data);
    } catch (error) {
      if (sequence === this.requestSequence) this.report(error);
    } finally { if (sequence === this.requestSequence) this.loading.set(false); }
  }

  async changeDate(date: string): Promise<void> {
    if (!date || this.busy()) return;
    this.date.set(date);
    this.error.set(''); this.notice.set('');
    await this.refresh();
  }

  report(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      this.error.set(error.error?.error ?? 'Não foi possível confirmar a operação. Confira o histórico e tente novamente com o mesmo pedido.');
    } else this.error.set(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
  }

  private async mutate(operation: () => Promise<unknown>, message: string): Promise<boolean> {
    if (this.busy()) return false;
    this.saving.set(true); this.error.set(''); this.notice.set('');
    try {
      await operation();
      this.notice.set(message);
      // A gravação já foi confirmada. Uma falha nesta leitura não desfaz a venda.
      await this.refresh();
      return true;
    } catch (error) {
      this.report(error);
      if (error instanceof HttpErrorResponse && error.status === 409) await this.refresh();
      return false;
    }
    finally { this.saving.set(false); }
  }

  saveSale(input: SaleInput) { return this.mutate(() => firstValueFrom(this.http.post('/api/sales', input)), 'Pedido registrado.'); }
  saveProduct(input: ProductInput, id?: number) {
    return this.mutate(() => firstValueFrom(id ? this.http.put(`/api/products/${id}`, input) : this.http.post('/api/products', input)), 'Produto salvo.');
  }
  addOwner(name: string) { return this.mutate(() => firstValueFrom(this.http.post('/api/owners', { name })), 'Participante cadastrada.'); }
  receive(id: string, paymentMethod: PaymentMethod) {
    return this.mutate(() => firstValueFrom(this.http.post(`/api/sales/${id}/receive`, { date: this.date(), paymentMethod })), 'Pagamento recebido na data selecionada.');
  }
  cancel(id: string) { return this.mutate(() => firstValueFrom(this.http.post(`/api/sales/${id}/cancel`, {})), 'Pedido cancelado.'); }
  saveDay(input: CashInput, close = false) {
    return this.mutate(() => firstValueFrom(close ? this.http.post(`/api/days/${this.date()}/close`, input) : this.http.put(`/api/days/${this.date()}`, input)), close ? 'Fechamento guardado no histórico.' : 'Conferência salva.');
  }
}
