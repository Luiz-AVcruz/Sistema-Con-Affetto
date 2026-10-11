import { z } from 'zod';
import { paymentMethods } from '@caixa/shared';

export const money = z.number().int().min(0).max(100_000_000);
export const businessDate = z.iso.date().refine(date => date >= '2020-01-01' && date <= '2100-12-31', 'Data fora do intervalo permitido');
export const productSchema = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(200),
  ownerId: z.number().int().positive(), priceCents: money,
  stock: z.number().int().min(0).max(1_000_000).nullable(), active: z.boolean()
}).strict();
export const productUpdateSchema = productSchema.extend({ expectedVersion: z.number().int().positive() });
const paymentOptions = { automaticFees: z.literal(true).optional(), cardEntry: z.enum(['Aproximação', 'Inserido']).optional() };
const splitPaymentSchema = z.object({
  paymentMethod: z.enum(['Dinheiro','Pix','Cartão débito','Cartão crédito']),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cardEntry: z.enum(['Aproximação','Inserido']).optional()
}).strict();
export const saleSchema = z.object({
  requestId: z.uuid(), date: businessDate, paymentMethod: z.enum(paymentMethods),
  fairId: z.number().int().positive().optional(),
  ...paymentOptions,
  status: z.enum(['Pago', 'Pendente']), note: z.string().trim().max(500),
  items: z.array(z.object({
    productId: z.number().int().positive(), quantity: z.number().int().min(1).max(10_000),
    expectedPriceCents: money,
    expectedName: z.string().trim().min(1).max(100).optional(),
    expectedOwnerId: z.number().int().positive().optional(),
    expectedOwnerName: z.string().trim().min(1).max(100).optional(),
    discountCents: money, feeCents: money
  }).strict()).min(1).max(100),
  payments: z.array(splitPaymentSchema).length(2).optional()
}).strict();
export const cashSchema = z.object({
  openingCents: money, extraCents: money, withdrawalCents: money,
  countedCents: money.nullable(), note: z.string().trim().max(500)
}).strict();
export const fairSchema = z.object({ name: z.string().trim().min(1).max(100), targetCents: money.refine(value => value > 0, 'A meta deve ser maior que zero').nullable() }).strict();
export const newFairSchema = fairSchema.extend({ startDate: businessDate });
export const receiveSchema = z.object({ date: businessDate, paymentMethod: z.enum(paymentMethods.slice(0, 4) as ['Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito']), ...paymentOptions }).strict();

export class BusinessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireCondition(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new BusinessError(status, message);
}
