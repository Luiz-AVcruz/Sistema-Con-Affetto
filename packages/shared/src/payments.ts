import type { CardEntry, PaymentMethod } from './index.js';

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
