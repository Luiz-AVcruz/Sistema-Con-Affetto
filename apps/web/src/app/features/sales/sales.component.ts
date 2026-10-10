import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { paymentMethods, type PaymentMethod, type Product } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, parseMoney } from '../../core/money';

interface CartItem { product: Product; quantity: number; discount: string; fee: string }
interface Draft { version: 1; requestId: string; date: string; items: CartItem[]; method: PaymentMethod; status: 'Pago' | 'Pendente'; note: string }
const draftKey = 'caixa-feira-draft-v1';

@Component({ selector: 'app-sales', standalone: true, imports: [FormsModule], templateUrl: './sales.component.html' })
export class SalesComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly methods = paymentMethods;
  readonly search = signal('');
  readonly cart = signal<CartItem[]>([]);
  readonly filtered = computed(() => {
    const query = this.search().toLocaleLowerCase('pt-BR');
    return (this.store.data()?.products ?? []).filter(product => product.active && `${product.name} ${product.ownerName}`.toLocaleLowerCase('pt-BR').includes(query));
  });
  method: PaymentMethod = 'Dinheiro';
  status: 'Pago' | 'Pendente' = 'Pago';
  note = '';
  draftDate = this.store.date();
  private requestId: string = crypto.randomUUID();

  constructor() {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const draft: Draft = JSON.parse(raw);
        if (draft.version !== 1 || !Array.isArray(draft.items) || !draft.items.every(item => item.product && Number.isInteger(item.product.id) && Number.isInteger(item.quantity) && item.quantity > 0 && typeof item.discount === 'string' && typeof item.fee === 'string') || !paymentMethods.includes(draft.method) || !['Pago', 'Pendente'].includes(draft.status) || typeof draft.requestId !== 'string' || typeof draft.date !== 'string' || typeof draft.note !== 'string') throw new Error('Rascunho inválido');
        this.cart.set(draft.items); this.method = draft.method; this.status = draft.status;
        this.note = draft.note; this.requestId = draft.requestId; this.draftDate = draft.date;
      }
    } catch { this.store.error.set('Não foi possível ler o rascunho local. Os pedidos registrados continuam no histórico.'); }
  }

  persist(): void {
    try {
      const draft: Draft = { version: 1, requestId: this.requestId, date: this.draftDate, items: this.cart(), method: this.method, status: this.status, note: this.note };
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch { this.store.error.set('O navegador não conseguiu guardar o rascunho. Registre o pedido antes de fechar a página.'); }
  }

  add(product: Product): void {
    if (this.store.busy() || this.store.data()?.day.closedAt) return;
    if (this.cart().length && this.draftDate !== this.store.date()) { this.store.error.set('O rascunho pertence a outro dia. Selecione essa data ou limpe o pedido.'); return; }
    if (!this.cart().length) this.draftDate = this.store.date();
    const existing = this.cart().find(item => item.product.id === product.id);
    if (product.stock !== null && product.stock < (existing?.quantity ?? 0) + 1) { this.store.error.set('Quantidade maior que o estoque disponível.'); return; }
    this.cart.update(items => existing ? items.map(item => item === existing ? { ...item, quantity: item.quantity + 1 } : item) : [...items, { product, quantity: 1, discount: '', fee: '' }]);
    this.persist();
  }

  update(id: number, field: 'quantity' | 'discount' | 'fee', value: number | string): void {
    this.cart.update(items => items.map(item => item.product.id === id ? { ...item, [field]: value } : item));
    this.persist();
  }
  remove(id: number): void { this.cart.update(items => items.filter(item => item.product.id !== id)); this.persist(); }
  clear(): void {
    this.cart.set([]); this.requestId = crypto.randomUUID(); this.draftDate = this.store.date(); this.note = '';
    this.method = 'Dinheiro'; this.status = 'Pago';
    this.persist();
  }
  nonCash(): boolean { return this.method === 'Permuta' || this.method === 'Não cobrado'; }
  setMethod(value: PaymentMethod): void { this.method = value; if (this.nonCash()) this.status = 'Pago'; this.persist(); }
  quote(): number | null {
    try {
      return this.cart().reduce((total, item) => {
        if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error('Quantidade inválida');
        const amount = item.product.priceCents * item.quantity - parseMoney(item.discount);
        if (amount < 0 || parseMoney(item.fee) > amount) throw new Error('Ajuste inválido');
        return total + (this.nonCash() ? 0 : amount);
      }, 0);
    } catch { return null; }
  }
  async submit(): Promise<void> {
    try {
      const saved = await this.store.saveSale({ requestId: this.requestId, date: this.draftDate,
        paymentMethod: this.method, status: this.status, note: this.note,
        items: this.cart().map(item => ({ productId: item.product.id, quantity: item.quantity,
          expectedPriceCents: item.product.priceCents, discountCents: parseMoney(item.discount), feeCents: parseMoney(item.fee) })) });
      if (saved) this.clear();
    } catch (error) { this.store.report(error); }
  }
}
