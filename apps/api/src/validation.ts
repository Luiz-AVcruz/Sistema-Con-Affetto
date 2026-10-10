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
export const saleSchema = z.object({
  requestId: z.uuid(), date: businessDate, paymentMethod: z.enum(paymentMethods),
  status: z.enum(['Pago', 'Pendente']), note: z.string().trim().max(500),
  items: z.array(z.object({
    productId: z.number().int().positive(), quantity: z.number().int().min(1).max(10_000),
    expectedPriceCents: money, discountCents: money, feeCents: money
  }).strict()).min(1).max(100)
}).strict();
export const cashSchema = z.object({
  openingCents: money, extraCents: money, withdrawalCents: money,
  countedCents: money.nullable(), note: z.string().trim().max(500)
}).strict();
export const receiveSchema = z.object({ date: businessDate, paymentMethod: z.enum(paymentMethods.slice(0, 4) as ['Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito']) }).strict();

export class BusinessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireCondition(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new BusinessError(status, message);
}
