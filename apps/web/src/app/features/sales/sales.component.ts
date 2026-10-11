import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { calculatePaymentFees, calculateSplitPaymentFees, paymentChoices, paymentChoiceValue, paymentMethods, paymentRate, type CardEntry, type PaymentMethod, type Product, type SaleInput, type SalePaymentInput } from '@caixa/shared';
import { CashStore } from '../../core/cash.store';
import { formatDay, formatMoney, parseMoney } from '../../core/money';

interface CartItem { product: Product; quantity: number; discount: string; fee: string }
interface Draft { version: 2; fairId: number; requestId: string; date: string; items: CartItem[]; method: PaymentMethod; status: 'Pago' | 'Pendente'; note: string; catalogExpectations?: boolean; pendingSubmission?: SaleInput; automaticFees?: boolean; cardEntry?: CardEntry | null; splitPayments?: boolean; secondMethod?: PaymentMethod; secondCardEntry?: CardEntry | null; firstPaymentAmount?: string }
interface LegacyDraft { version: 1; requestId: string; date: string; items: CartItem[]; method: PaymentMethod; status: 'Pago' | 'Pendente'; note: string }
const legacyDraftKey = 'caixa-feira-draft-v1';
const draftKey = (fairId: number) => `caixa-feira-draft-v2-${fairId}`;

@Component({ selector: 'app-sales', standalone: true, imports: [FormsModule], templateUrl: './sales.component.html' })
export class SalesComponent {
  readonly store = inject(CashStore);
  readonly money = formatMoney;
  readonly dayLabel = formatDay;
  readonly methods = paymentChoices;
  readonly splitMethods = paymentChoices.filter(choice => choice.method !== 'Permuta' && choice.method !== 'Não cobrado');
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
  splitPayments = false;
  secondMethod: PaymentMethod = 'Pix';
  secondCardEntry: CardEntry | null = null;
  firstPaymentAmount = '';
  automaticFees = true;
  cardEntry: CardEntry | null = null;
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
    const financialMethods: PaymentMethod[] = ['Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito'];
    return (draft.version === 1 || draft.version === 2) && Array.isArray(draft.items) && draft.items.every(item => item && item.product && Number.isInteger(item.product.id) && Number.isInteger(item.quantity) && item.quantity > 0 && typeof item.discount === 'string' && typeof item.fee === 'string') && paymentMethods.includes(draft.method as PaymentMethod) && ['Pago', 'Pendente'].includes(draft.status ?? '') && typeof draft.requestId === 'string' && typeof draft.date === 'string' && typeof draft.note === 'string' && (draft.version === 1 || Number.isInteger(draft.fairId))
      && (frozen === undefined || frozen && frozen.requestId === draft.requestId && frozen.fairId === draft.fairId
        && frozen.date === draft.date && paymentMethods.includes(frozen.paymentMethod) && ['Pago', 'Pendente'].includes(frozen.status)
        && typeof frozen.note === 'string' && Array.isArray(frozen.items) && frozen.items.length > 0)
      && (draft.automaticFees === undefined || typeof draft.automaticFees === 'boolean')
      && (draft.cardEntry === undefined || draft.cardEntry === null || draft.cardEntry === 'Aproximação' || draft.cardEntry === 'Inserido')
      && (draft.splitPayments === undefined || typeof draft.splitPayments === 'boolean')
      && (draft.secondMethod === undefined || paymentMethods.includes(draft.secondMethod as PaymentMethod))
      && (draft.secondCardEntry === undefined || draft.secondCardEntry === null || draft.secondCardEntry === 'Aproximação' || draft.secondCardEntry === 'Inserido')
      && (draft.firstPaymentAmount === undefined || typeof draft.firstPaymentAmount === 'string')
      && (draft.splitPayments !== true || draft.status === 'Pago'
        && financialMethods.includes(draft.method as PaymentMethod)
        && financialMethods.includes(draft.secondMethod as PaymentMethod)
        && typeof draft.firstPaymentAmount === 'string');
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
        this.splitPayments = draft.splitPayments === true;
        this.automaticFees = this.splitPayments || draft.automaticFees === true || !draft.items.length && !draft.pendingSubmission;
        this.cardEntry = draft.cardEntry ?? null;
        this.secondMethod = draft.secondMethod ?? 'Pix';
        this.secondCardEntry = draft.secondCardEntry ?? null;
        this.firstPaymentAmount = draft.firstPaymentAmount ?? '';
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
          this.automaticFees = !migrated.items.length; this.cardEntry = null;
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
    this.automaticFees = true; this.cardEntry = null; this.splitPayments = false;
    this.secondMethod = 'Pix'; this.secondCardEntry = null; this.firstPaymentAmount = '';
  }

  persist(): boolean {
    const fairId = this.loadedFairId;
    if (fairId === null) return false;
    try {
      const draft: Draft = { version: 2, fairId, requestId: this.requestId, date: this.draftDate, items: this.cart(), method: this.method, status: this.status, note: this.note,
        automaticFees: this.automaticFees, cardEntry: this.cardEntry,
        ...(this.splitPayments ? { splitPayments: true, secondMethod: this.secondMethod, secondCardEntry: this.secondCardEntry, firstPaymentAmount: this.firstPaymentAmount } : {}),
        catalogExpectations: this.catalogExpectations, ...(this.pendingSubmission() ? { pendingSubmission: this.pendingSubmission()! } : {}) };
      localStorage.setItem(draftKey(fairId), JSON.stringify(draft));
      return true;
    } catch { this.store.error.set('Não foi possível guardar o rascunho neste dispositivo.'); return false; }
  }

  add(product: Product): void {
    if (this.store.busy() || this.pendingSubmission() || this.store.data()?.fair.closedAt || this.store.data()?.day.closedAt) return;
    if (this.cart().length && this.draftDate !== this.store.date()) { this.store.error.set('O rascunho pertence a outro dia. Selecione essa data ou limpe o pedido.'); return; }
    if (!this.cart().length) { this.draftDate = this.store.date(); this.automaticFees = true; }
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
  remove(id: number): void {
    if (this.pendingSubmission()) return;
    this.cart.update(items => items.filter(item => item.product.id !== id));
    if (!this.cart().length) this.automaticFees = true;
    this.persist();
  }
  clear(): void {
    if (this.pendingSubmission()) return;
    this.resetEmptyDraft();
    this.persist();
  }
  nonCash(): boolean { return this.method === 'Permuta' || this.method === 'Não cobrado'; }
  get paymentChoice(): string { return paymentChoiceValue(this.method, this.cardEntry); }
  get secondPaymentChoice(): string { return paymentChoiceValue(this.secondMethod, this.secondCardEntry); }
  setStatus(value: 'Pago' | 'Pendente'): void {
    if (this.pendingSubmission() || this.splitPayments && value !== 'Pago') return;
    this.status = value;
    this.persist();
  }
  setSplitPayments(enabled: boolean): void {
    if (this.store.busy() || this.pendingSubmission()) return;
    if (enabled && (this.status !== 'Pago' || this.nonCash())) return;
    this.splitPayments = enabled;
    if (enabled) {
      this.status = 'Pago';
      if (!this.automaticFees) this.cart.update(items => items.map(item => ({ ...item, fee: '' })));
      this.automaticFees = true;
      this.firstPaymentAmount = '';
      const next = this.splitMethods.find(choice => choice.value !== this.paymentChoice);
      this.secondMethod = next?.method ?? 'Pix';
      this.secondCardEntry = next && 'cardEntry' in next ? next.cardEntry : null;
    }
    this.persist();
  }
  setFirstPaymentAmount(value: string): void {
    if (this.pendingSubmission()) return;
    this.firstPaymentAmount = value;
    this.persist();
  }
  setSecondPayment(value: string): void {
    if (this.pendingSubmission()) return;
    const choice = this.splitMethods.find(choice => choice.value === value);
    if (!choice) return;
    this.secondMethod = choice.method;
    this.secondCardEntry = 'cardEntry' in choice ? choice.cardEntry : null;
    this.persist();
  }
  setMethod(value: string): void {
    if (this.pendingSubmission()) return;
    const choices = this.splitPayments ? this.splitMethods : paymentChoices;
    const choice = choices.find(choice => choice.value === value);
    if (!choice) return;
    if (!this.automaticFees) {
      this.automaticFees = true;
      this.cart.update(items => items.map(item => ({ ...item, fee: '' })));
    }
    this.method = choice.method;
    this.cardEntry = 'cardEntry' in choice ? choice.cardEntry : null;
    if (this.splitPayments) this.status = 'Pago';
    else if (this.nonCash()) {
      this.status = 'Pago';
      this.cart.update(items => items.map(item => ({ ...item, discount: '', fee: '' })));
    }
    this.persist();
  }
  enableAutomaticFees(): void {
    if (this.store.busy() || this.pendingSubmission()) return;
    this.automaticFees = true;
    this.cart.update(items => items.map(item => ({ ...item, fee: '' })));
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
    const splitInputs = this.splitPayments ? this.splitPaymentInputs() : null;
    if (this.splitPayments && (!splitInputs || !this.splitFeeCalculation())) throw new Error(this.splitError() ?? 'Confira as duas formas de pagamento.');
    return { fairId, requestId: this.requestId, date: this.draftDate,
      paymentMethod: this.method, status: this.status, note: this.note,
      ...(this.automaticFees ? { automaticFees: true as const, ...(this.method.startsWith('Cartão') ? { cardEntry: this.cardEntry ?? 'Aproximação' as const } : {}) } : {}),
      ...(this.splitPayments ? { payments: splitInputs! } : {}),
      items: this.cart().map(item => ({ productId: item.product.id, quantity: item.quantity, expectedPriceCents: item.product.priceCents,
        ...(this.catalogExpectations ? { expectedName: item.product.name, expectedOwnerId: item.product.ownerId, expectedOwnerName: item.product.ownerName } : {}),
        discountCents: parseMoney(item.discount), feeCents: this.automaticFees ? 0 : parseMoney(item.fee) })) };
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
  feeQuote(): number | null {
    try {
      if (this.quote() === null) return null;
      if (this.splitPayments) {
        const calculation = this.splitFeeCalculation();
        return calculation ? calculation.payments.reduce((sum, payment) => sum + payment.feeCents, 0) : null;
      }
      if (!this.automaticFees) return this.cart().reduce((sum, item) => sum + parseMoney(item.fee), 0);
      const amounts = this.cart().map(item => this.nonCash() ? 0 : item.product.priceCents * item.quantity - parseMoney(item.discount));
      return calculatePaymentFees(amounts, this.method, this.cardEntry).reduce((sum, fee) => sum + fee, 0);
    } catch { return null; }
  }
  netQuote(): number | null {
    const total = this.quote(), fee = this.feeQuote();
    return total === null || fee === null ? null : total - fee;
  }
  rateLabel(): string { return this.splitPayments ? 'duas formas' : (paymentRate(this.method, this.cardEntry) / 100).toFixed(2).replace('.', ',') + '%'; }
  secondPaymentAmount(): number | null {
    const total = this.quote();
    if (total === null) return null;
    try { return total - parseMoney(this.firstPaymentAmount); }
    catch { return null; }
  }
  splitError(): string | null {
    if (!this.splitPayments) return null;
    if (this.status !== 'Pago' || this.nonCash()) return 'A divisão está disponível somente para pedidos pagos com formas financeiras.';
    const total = this.quote();
    if (total === null || total <= 0) return 'Confira os valores e descontos dos itens antes de dividir o pagamento.';
    let first: number;
    try { first = parseMoney(this.firstPaymentAmount); }
    catch { return 'Informe o valor do primeiro pagamento em reais.'; }
    if (first <= 0) return 'O valor do primeiro pagamento deve ser maior que zero.';
    if (first >= total) return 'O segundo pagamento também deve ser maior que zero.';
    if (this.paymentChoice === this.secondPaymentChoice) return 'Escolha formas de pagamento diferentes.';
    return this.splitFeeCalculation() ? null : 'Confira as duas formas e os valores do pagamento.';
  }
  private splitPaymentInputs(): SalePaymentInput[] | null {
    if (this.status !== 'Pago' || this.nonCash()) return null;
    const total = this.quote();
    if (total === null) return null;
    let first: number;
    try { first = parseMoney(this.firstPaymentAmount); }
    catch { return null; }
    const second = total - first;
    if (first <= 0 || second <= 0) return null;
    const firstChoice = this.splitMethods.find(choice => choice.value === this.paymentChoice);
    const secondChoice = this.splitMethods.find(choice => choice.value === this.secondPaymentChoice);
    if (!firstChoice || !secondChoice || firstChoice.value === secondChoice.value) return null;
    return [
      { paymentMethod: firstChoice.method, amountCents: first, ...('cardEntry' in firstChoice ? { cardEntry: firstChoice.cardEntry } : {}) },
      { paymentMethod: secondChoice.method, amountCents: second, ...('cardEntry' in secondChoice ? { cardEntry: secondChoice.cardEntry } : {}) }
    ];
  }
  private splitFeeCalculation() {
    const inputs = this.splitPaymentInputs();
    if (!inputs) return null;
    try {
      const amounts = this.cart().map(item => item.product.priceCents * item.quantity - parseMoney(item.discount));
      const owners = this.cart().map(item => item.product.ownerId);
      return calculateSplitPaymentFees(amounts, owners, inputs);
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
