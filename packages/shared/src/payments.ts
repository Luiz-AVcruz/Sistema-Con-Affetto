import type { CardEntry, PaymentMethod, SalePayment, SalePaymentInput } from './index.js';

export const paymentChoices = [
  { value: 'Dinheiro', label: 'Dinheiro', method: 'Dinheiro' },
  { value: 'Pix', label: 'Pix', method: 'Pix' },
  { value: 'Cartão débito', label: 'Cartão débito (aproximação)', method: 'Cartão débito', cardEntry: 'Aproximação' },
  { value: 'Cartão crédito', label: 'Cartão crédito (aproximação)', method: 'Cartão crédito', cardEntry: 'Aproximação' },
  { value: 'Cartão débito inserido', label: 'Cartão débito (inserido)', method: 'Cartão débito', cardEntry: 'Inserido' },
  { value: 'Cartão crédito inserido', label: 'Cartão crédito (inserido)', method: 'Cartão crédito', cardEntry: 'Inserido' },
  { value: 'Permuta', label: 'Permuta', method: 'Permuta' },
  { value: 'Não cobrado', label: 'Não cobrado', method: 'Não cobrado' }
] as const;

export function paymentChoiceValue(method: PaymentMethod, entry: CardEntry | null = null): string {
  return entry === 'Inserido' && method.startsWith('Cartão') ? `${method} inserido` : method;
}
export function paymentLabel(method: PaymentMethod, entry: CardEntry | null = null): string {
  return paymentChoices.find(choice => choice.value === paymentChoiceValue(method, entry))?.label ?? method;
}

// Centésimos de porcentagem, confirmados para esta feira. Não alteram taxas já gravadas.
export function paymentRate(method: PaymentMethod, entry: CardEntry | null = null): number {
  if (method === 'Cartão débito') return entry === 'Inserido' ? 199 : 89;
  if (method === 'Cartão crédito') return entry === 'Inserido' ? 498 : 309;
  return 0;
}

// Arredonda uma vez por transação e distribui os centavos restantes pelos maiores
// restos. Cada item arca com sua parte e a soma confere com a taxa do pedido.
export function calculatePaymentFees(amounts: readonly number[], method: PaymentMethod, entry: CardEntry | null = null): number[] {
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount < 0)) throw new Error('Valor inválido para calcular a taxa.');
  const rate = BigInt(paymentRate(method, entry));
  const parts = amounts.map((amount, index) => {
    const numerator = BigInt(amount) * rate;
    return { index, fee: Number(numerator / 10000n), remainder: Number(numerator % 10000n) };
  });
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  const fee = Number((total * rate + 5000n) / 10000n);
  const remaining = fee - parts.reduce((sum, part) => sum + part.fee, 0);
  const priority = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const part of priority.slice(0, remaining)) part.fee++;
  return parts.map(part => part.fee);
}

// A quota é exata; somente os centavos indivisíveis usam os maiores restos.
function allocateCents(total: number, weights: readonly number[]): number[] {
  const denominator = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (!denominator) {
    if (total !== 0) throw new Error('Não é possível ratear uma taxa sem valor recebido.');
    return weights.map(() => 0);
  }
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, fee: Number(numerator / denominator), remainder: numerator % denominator };
  });
  const remaining = total - parts.reduce((sum, part) => sum + part.fee, 0);
  const priority = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const part of priority.slice(0, remaining)) part.fee++;
  return parts.map(part => part.fee);
}

export function calculateSplitPaymentFees(amounts: readonly number[], ownerIds: readonly number[], inputs: readonly SalePaymentInput[]): { fees: number[]; payments: SalePayment[] } {
  if (amounts.some(amount => !Number.isSafeInteger(amount) || amount < 0) || ownerIds.length !== amounts.length
    || ownerIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Itens inválidos para dividir o pagamento.');
  if (inputs.length !== 2) throw new Error('Informe exatamente duas formas de pagamento.');
  const payments = inputs.map(input => {
    if (!['Dinheiro','Pix','Cartão débito','Cartão crédito'].includes(input.paymentMethod)
      || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Cada pagamento deve ter uma forma válida e um valor maior que zero.');
    const card = input.paymentMethod.startsWith('Cartão');
    if (input.cardEntry !== undefined && (!card || !['Aproximação','Inserido'].includes(input.cardEntry))) throw new Error('A leitura do cartão só pode ser informada em pagamentos de cartão.');
    const cardEntry = card ? input.cardEntry ?? 'Aproximação' : null;
    const feeCents = calculatePaymentFees([input.amountCents], input.paymentMethod, cardEntry)[0];
    return { paymentMethod: input.paymentMethod, amountCents: input.amountCents, cardEntry, feeCents, netCents: input.amountCents - feeCents };
  });
  if (payments[0].paymentMethod === payments[1].paymentMethod && payments[0].cardEntry === payments[1].cardEntry) throw new Error('Escolha duas formas de pagamento diferentes.');
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || payments.reduce((sum, payment) => sum + BigInt(payment.amountCents), 0n) !== total) throw new Error('A soma dos dois pagamentos deve ser igual ao total do pedido.');
  const groups = new Map<number, { indices: number[]; weights: number[]; total: number }>();
  amounts.forEach((amount, index) => {
    const group = groups.get(ownerIds[index]) ?? { indices: [], weights: [], total: 0 };
    group.indices.push(index); group.weights.push(amount); group.total += amount; groups.set(ownerIds[index], group);
  });
  const entries = [...groups.values()];
  const ownerFees = allocateCents(payments.reduce((sum, payment) => sum + payment.feeCents, 0), entries.map(group => group.total));
  const fees = amounts.map(() => 0);
  entries.forEach((group, index) => {
    allocateCents(ownerFees[index], group.weights).forEach((fee, item) => { fees[group.indices[item]] = fee; });
  });
  return { fees, payments };
}
