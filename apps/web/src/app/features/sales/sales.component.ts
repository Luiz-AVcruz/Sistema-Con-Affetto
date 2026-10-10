import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { paymentMethods, type PaymentMethod, type Product, type SaleInput } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, parseMoney } from '../../core/money';

interface CartItem { product: Product; quantity: number; discount: string; fee: string }
interface Draft { version: 2; fairId: number; requestId: string; date: string; items: CartItem[]; method: PaymentMethod; status: 'Pago' | 'Pendente'; note: string; catalogExpectations?: boolean; pendingSubmission?: SaleInput }
interface LegacyDraft { version: 1; requestId: string; date: string; items: CartItem[]; method: PaymentMethod; status: 'Pago' | 'Pendente'; note: string }
const legacyDraftKey = 'caixa-feira-draft-v1';
const draftKey = (fairId: number) => `caixa-feira-draft-v2-${fairId}`;

@Component({ selector: 'app-sales', standalone: true, imports: [FormsModule], templateUrl: './sales.component.html' })
export class SalesComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly methods = paymentMethods;
  readonly search = signal('');
  readonly cart = signal<CartItem[]>([]);
  readonly pendingSubmission = signal<SaleInput | null>(null);
  readonly catalogChanged = computed(() => this.cart().some(item => {
    const current = this.store.data()?.products.find(product => product.id === item.product.id);
    return !current || !current.active || current.name !== item.product.name || current.priceCents !== item.product.priceCents
      || current.ownerId !== item.product.ownerId || current.ownerName !== item.product.ownerName;
  }));
  readonly filtered = computed(() => {
    const query = this.search().toLocaleLowerCase('pt-BR');
    return (this.store.data()?.products ?? []).filter(product => product.active && `${product.name} ${product.ownerName}`.toLocaleLowerCase('pt-BR').includes(query));
  });
  method: PaymentMethod = 'Dinheiro';
  status: 'Pago' | 'Pendente' = 'Pago';
  note = '';
  draftDate = this.store.date();
  private requestId: string = crypto.randomUUID();
  private loadedFairId: number | null = null;
  private catalogExpectations = true;

  constructor() {
    effect(() => {
      const data = this.store.data();
      if (!data || data.fair.id === this.loadedFairId) return;
      this.loadedFairId = data.fair.id;
      this.loadDraft(data.fair.id, data.fairs.reduce((oldest, fair) => Math.min(oldest, fair.id), data.fair.id));
    });
  }

  private validDraft(value: unknown): value is Draft | LegacyDraft {
    if (!value || typeof value !== 'object') return false;
    const draft = value as Omit<Partial<Draft>, 'version'> & { version?: number };
    const frozen = draft.pendingSubmission;
    return (draft.version === 1 || draft.version === 2) && Array.isArray(draft.items) && draft.items.every(item => item && item.product && Number.isInteger(item.product.id) && Number.isInteger(item.quantity) && item.quantity > 0 && typeof item.discount === 'string' && typeof item.fee === 'string') && paymentMethods.includes(draft.method as PaymentMethod) && ['Pago', 'Pendente'].includes(draft.status ?? '') && typeof draft.requestId === 'string' && typeof draft.date === 'string' && typeof draft.note === 'string' && (draft.version === 1 || Number.isInteger(draft.fairId))
      && (frozen === undefined || frozen && frozen.requestId === draft.requestId && frozen.fairId === draft.fairId
        && frozen.date === draft.date && paymentMethods.includes(frozen.paymentMethod) && ['Pago', 'Pendente'].includes(frozen.status)
        && typeof frozen.note === 'string' && Array.isArray(frozen.items) && frozen.items.length > 0);
  }

  private loadDraft(fairId: number, oldestFairId: number): void {
    try {
      const key = draftKey(fairId);
      const raw = localStorage.getItem(key);
      if (raw) {
        const draft: unknown = JSON.parse(raw);
        if (!this.validDraft(draft) || draft.version !== 2 || draft.fairId !== fairId) throw new Error('Rascunho inválido ou associado a outra feira');
        this.cart.set(draft.items); this.method = draft.method; this.status = draft.status;
        this.note = draft.note; this.requestId = draft.requestId; this.draftDate = draft.date;
        this.catalogExpectations = draft.catalogExpectations === true;
        this.pendingSubmission.set(draft.pendingSubmission ?? null);
      } else if (fairId === oldestFairId) {
        const legacy = localStorage.getItem(legacyDraftKey);
        if (legacy) {
          const previous: unknown = JSON.parse(legacy);
          if (!this.validDraft(previous) || previous.version !== 1) throw new Error('Rascunho antigo inválido');
          const migrated: Draft = { ...previous, version: 2, fairId };
          localStorage.setItem(key, JSON.stringify(migrated));
          localStorage.removeItem(legacyDraftKey);
          this.cart.set(migrated.items); this.method = migrated.method; this.status = migrated.status;
          this.note = migrated.note; this.requestId = migrated.requestId; this.draftDate = migrated.date;
          this.catalogExpectations = false; this.pendingSubmission.set(null);
        } else this.resetEmptyDraft();
      } else this.resetEmptyDraft();
      // Um rascunho antigo pode ser um POST confirmado cuja resposta se perdeu.
      // Recuperá-lo mantém o formato original, sem acrescentar campos ao hash.
      if (!this.pendingSubmission() && this.store.data()?.sales.some(sale => sale.id === this.requestId)) {
        this.pendingSubmission.set(this.saleInput(fairId));
      }
    } catch {
      this.resetEmptyDraft();
      this.store.error.set('Não foi possível ler o rascunho desta feira. Os pedidos registrados continuam no histórico.');
    }
  }

  private resetEmptyDraft(): void {
    this.cart.set([]); this.requestId = crypto.randomUUID(); this.note = ''; this.method = 'Dinheiro'; this.status = 'Pago'; this.draftDate = this.store.date();
    this.catalogExpectations = true; this.pendingSubmission.set(null);
  }

  persist(): boolean {
    const fairId = this.loadedFairId;
    if (fairId === null) return false;
    try {
      const draft: Draft = { version: 2, fairId, requestId: this.requestId, date: this.draftDate, items: this.cart(), method: this.method, status: this.status, note: this.note,
        catalogExpectations: this.catalogExpectations, ...(this.pendingSubmission() ? { pendingSubmission: this.pendingSubmission()! } : {}) };
      localStorage.setItem(draftKey(fairId), JSON.stringify(draft));
      return true;
    } catch { this.store.error.set('Não foi possível guardar o rascunho neste dispositivo.'); return false; }
  }

  add(product: Product): void {
    if (this.store.busy() || this.pendingSubmission() || this.store.data()?.fair.closedAt || this.store.data()?.day.closedAt) return;
    if (this.cart().length && this.draftDate !== this.store.date()) { this.store.error.set('O rascunho pertence a outro dia. Selecione essa data ou limpe o pedido.'); return; }
    if (!this.cart().length) this.draftDate = this.store.date();
    const existing = this.cart().find(item => item.product.id === product.id);
    if (product.stock !== null && product.stock < (existing?.quantity ?? 0) + 1) { this.store.error.set('Quantidade maior que o estoque disponível.'); return; }
    this.cart.update(items => existing ? items.map(item => item === existing ? { ...item, quantity: item.quantity + 1 } : item) : [...items, { product, quantity: 1, discount: '', fee: '' }]);
    this.persist();
  }

  update(id: number, field: 'quantity' | 'discount' | 'fee', value: number | string): void {
    if (this.pendingSubmission()) return;
    this.cart.update(items => items.map(item => item.product.id === id ? { ...item, [field]: value } : item));
    this.persist();
  }
  remove(id: number): void { if (this.pendingSubmission()) return; this.cart.update(items => items.filter(item => item.product.id !== id)); this.persist(); }
  clear(): void {
    if (this.pendingSubmission()) return;
    this.resetEmptyDraft();
    this.persist();
  }
  nonCash(): boolean { return this.method === 'Permuta' || this.method === 'Não cobrado'; }
  setMethod(value: PaymentMethod): void {
    if (this.pendingSubmission()) return;
    this.method = value;
    if (this.nonCash()) {
      this.status = 'Pago';
      this.cart.update(items => items.map(item => ({ ...item, discount: '', fee: '' })));
    }
    this.persist();
  }
  updateCatalog(): void {
    if (this.store.busy() || this.pendingSubmission()) return;
    const products = this.store.data()?.products ?? [];
    if (this.cart().some(item => !products.some(product => product.id === item.product.id && product.active))) {
      this.store.error.set('Remova do pedido os produtos ausentes ou inativos antes de atualizar.'); return;
    }
    this.cart.update(items => items.map(item => ({ ...item, product: products.find(product => product.id === item.product.id)! })));
    this.catalogExpectations = true;
    this.persist();
  }
  private saleInput(fairId: number): SaleInput {
    return { fairId, requestId: this.requestId, date: this.draftDate,
      paymentMethod: this.method, status: this.status, note: this.note,
      items: this.cart().map(item => ({ productId: item.product.id, quantity: item.quantity, expectedPriceCents: item.product.priceCents,
        ...(this.catalogExpectations ? { expectedName: item.product.name, expectedOwnerId: item.product.ownerId, expectedOwnerName: item.product.ownerName } : {}),
        discountCents: parseMoney(item.discount), feeCents: parseMoney(item.fee) })) };
  }
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
    if (this.store.busy()) return;
    const fairId = this.store.data()?.fair.id;
    if (fairId === undefined || fairId !== this.loadedFairId || this.store.data()?.fair.closedAt && !this.pendingSubmission()) {
      this.store.error.set('Este rascunho pertence a uma feira encerrada ou diferente da selecionada.'); return;
    }
    try {
      if (!this.pendingSubmission() && this.catalogChanged()) {
        this.store.error.set('O cadastro mudou. Confira e atualize os itens do pedido antes de registrar.'); return;
      }
      const frozen = this.pendingSubmission();
      const input = frozen ?? this.saleInput(fairId);
      this.pendingSubmission.set(input);
      if (!this.persist()) {
        if (!frozen) this.pendingSubmission.set(null);
        this.store.error.set('Não foi possível preservar o corpo do pedido para recuperação. Nenhuma venda foi enviada.'); return;
      }
      const outcome = await this.store.saveSale(input, frozen !== null);
      if (outcome === 'saved') { this.pendingSubmission.set(null); this.clear(); }
      else if (outcome === 'rejected' || outcome === 'busy') { this.pendingSubmission.set(null); this.persist(); }
    } catch (error) { this.store.report(error); }
  }
}
