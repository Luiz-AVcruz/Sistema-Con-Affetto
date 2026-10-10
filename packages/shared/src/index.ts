export const paymentMethods = ['Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito', 'Permuta', 'Não cobrado'] as const;
export type PaymentMethod = typeof paymentMethods[number];
export type SaleStatus = 'Pago' | 'Pendente' | 'Cancelado';
export interface Owner { id: number; name: string }
export interface Product {
  id: number; name: string; description: string; ownerId: number; ownerName: string;
  priceCents: number; stock: number | null; active: boolean; version: number;
}
export interface ProductInput {
  name: string; description: string; ownerId: number; priceCents: number;
  stock: number | null; active: boolean; expectedVersion?: number;
}
export interface SaleItemInput {
  productId: number; quantity: number; expectedPriceCents: number;
  discountCents: number; feeCents: number;
}
export interface SaleInput {
  requestId: string; date: string; paymentMethod: PaymentMethod;
  status: 'Pago' | 'Pendente'; note: string; items: SaleItemInput[];
}
export interface SaleItem extends SaleItemInput {
  name: string; ownerId: number; ownerName: string; priceCents: number;
  grossCents: number; totalCents: number; netCents: number;
}
export interface Sale {
  id: string; date: string; paymentDate: string | null; paymentMethod: PaymentMethod;
  status: SaleStatus; note: string; createdAt: string; origin: 'Aplicativo' | 'Planilha'; items: SaleItem[];
  grossCents: number; discountCents: number; feeCents: number;
  totalCents: number; netCents: number;
}
export interface Summary {
  receivedCents: number; netCents: number; discountCents: number; feeCents: number;
  pendingCents: number; paidCount: number; barterUnits: number; giftUnits: number;
  byOwner: { ownerId: number; name: string; netCents: number }[];
  byPayment: { method: PaymentMethod; totalCents: number }[];
}
export interface CashInput {
  openingCents: number; extraCents: number; withdrawalCents: number;
  countedCents: number | null; note: string;
}
export interface Day extends CashInput {
  date: string; closedAt: string | null; summary: Summary;
  expectedCents: number; differenceCents: number | null;
}
export interface Bootstrap {
  owners: Owner[]; products: Product[]; sales: Sale[]; day: Day;
  total: Summary; closedDays: Day[];
}
