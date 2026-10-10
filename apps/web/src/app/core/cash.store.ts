import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Bootstrap, SaleInput, ProductInput, CashInput, PaymentMethod, Fair, FairInput } from '@caixa/shared';
import { localDate } from './money';

@Injectable({ providedIn: 'root' })
export class CashStore {
  private readonly http = inject(HttpClient);
  private requestSequence = 0;
  readonly data = signal<Bootstrap | null>(null);
  readonly date = signal(localDate());
  readonly selectedFairId = signal<number | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly busy = computed(() => this.loading() || this.saving());
  readonly error = signal('');
  readonly notice = signal('');

  async refresh(): Promise<void> {
    const sequence = ++this.requestSequence;
    const date = this.date();
    this.loading.set(true);
    const fairId = this.selectedFairId();
    if (this.data()?.day.date !== date || this.data()?.fair.id !== fairId && fairId !== null) this.data.set(null);
    try {
      const params: Record<string, string> = { date };
      if (fairId !== null) params['fairId'] = String(fairId);
      const data = await firstValueFrom(this.http.get<Bootstrap>('/api/bootstrap', { params }));
      if (sequence === this.requestSequence) { this.selectedFairId.set(data.fair.id); this.data.set(data); }
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

  async selectFair(id: number): Promise<void> {
    if (!Number.isInteger(id) || id < 1 || this.busy() || id === this.selectedFairId()) return;
    this.selectedFairId.set(id);
    this.error.set(''); this.notice.set('');
    this.data.set(null);
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

  saveSale(input: SaleInput) {
    const fairId = this.data()?.fair.id;
    if (fairId === undefined || this.data()?.fair.closedAt) { this.error.set('Selecione uma feira ativa para registrar pedidos.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(this.http.post('/api/sales', { ...input, fairId })), 'Pedido registrado.');
  }
  saveProduct(input: ProductInput, id?: number) {
    return this.mutate(() => firstValueFrom(id ? this.http.put(`/api/products/${id}`, input) : this.http.post('/api/products', input)), 'Produto salvo.');
  }
  addOwner(name: string) { return this.mutate(() => firstValueFrom(this.http.post('/api/owners', { name })), 'Participante cadastrada.'); }
  receive(id: string, paymentMethod: PaymentMethod) {
    const fairId = this.data()?.fair.id;
    if (fairId === undefined || this.data()?.fair.closedAt) { this.error.set('Esta feira está encerrada e não aceita recebimentos.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(this.http.post(`/api/sales/${id}/receive`, { date: this.date(), paymentMethod }, { params: { fairId } })), 'Pagamento recebido na data selecionada.');
  }
  cancel(id: string) {
    const fairId = this.data()?.fair.id;
    if (fairId === undefined || this.data()?.fair.closedAt) { this.error.set('Esta feira está encerrada e não aceita cancelamentos.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(this.http.post(`/api/sales/${id}/cancel`, {}, { params: { fairId } })), 'Pedido cancelado.');
  }
  saveDay(input: CashInput, close = false) {
    const fairId = this.data()?.fair.id;
    if (fairId === undefined || this.data()?.fair.closedAt) { this.error.set('Esta feira está encerrada e não aceita alterações no fechamento.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(close ? this.http.post(`/api/days/${this.date()}/close`, input, { params: { fairId } }) : this.http.put(`/api/days/${this.date()}`, input, { params: { fairId } })), close ? 'Fechamento guardado no histórico.' : 'Conferência salva.');
  }

  saveFair(input: FairInput) {
    const id = this.data()?.fair.id;
    if (id === undefined || this.data()?.fair.closedAt) { this.error.set('Somente a feira ativa pode ser editada.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(this.http.put<Fair>(`/api/fairs/${id}`, input)), 'Meta da feira salva.');
  }

  createFair(input: FairInput & { startDate: string }) {
    return this.mutate(async () => {
      const created = await firstValueFrom(this.http.post<Fair>('/api/fairs', input));
      this.selectedFairId.set(created.id);
    }, 'Nova feira criada.');
  }

  closeFair(date: string) {
    const id = this.data()?.fair.id;
    if (id === undefined || this.data()?.fair.closedAt) { this.error.set('Esta feira já está encerrada.'); return Promise.resolve(false); }
    return this.mutate(() => firstValueFrom(this.http.post(`/api/fairs/${id}/close`, { date })), 'Feira encerrada e guardada no histórico.');
  }
}
