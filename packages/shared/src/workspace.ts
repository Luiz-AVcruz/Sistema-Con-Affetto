import type { PaymentMethod, Product, SaleInput } from './index.js';

export const workspaceViews = ['Vender', 'Produtos', 'Fechamento', 'Histórico', 'Feiras'] as const;
export type WorkspaceView = typeof workspaceViews[number];

export interface WorkspaceState {
  version: 1;
  date: string;
  fairId: number | null;
  view: WorkspaceView;
  drafts: Record<string, string>;
}

export interface WorkspaceInfo {
  generation: string;
  savedAt: string;
  state: WorkspaceState;
  importId: string | null;
  backupPath: string | null;
}

export interface SnapshotSummary {
  savedAt: string;
  date: string;
  view: WorkspaceView;
  fairId: number | null;
  owners: number;
  products: number;
  sales: number;
  days: number;
  fairs: number;
  drafts: number;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentMethodSet = new Set<string>(['Dinheiro', 'Pix', 'Cartão débito', 'Cartão crédito', 'Permuta', 'Não cobrado']);
const draftV2Prefix = 'caixa-feira-draft-v2-';
const maxWorkspaceBytes = 1024 * 1024;

function invalid(message: string): never { throw new TypeError(`Estado do aplicativo inválido: ${message}`); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2020-01-01' || value > '2100-12-31') return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function boundedText(value: unknown, max: number, nonEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (!nonEmpty || value.trim().length > 0);
}
function validInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function validId(value: unknown): value is number { return validInteger(value, 1); }
function validCents(value: unknown): value is number { return validInteger(value, 0, 100_000_000); }
function validPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && paymentMethodSet.has(value);
}
function validStatus(value: unknown): value is 'Pago' | 'Pendente' {
  return value === 'Pago' || value === 'Pendente';
}
function validUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}
function validProduct(value: unknown): value is Product {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'description', 'ownerId', 'ownerName', 'priceCents', 'stock', 'active', 'version'])) return false;
  return validId(value.id) && boundedText(value.name, 100, true) && boundedText(value.description, 200)
    && validId(value.ownerId) && boundedText(value.ownerName, 100, true) && validCents(value.priceCents)
    && (value.stock === null || validInteger(value.stock, 0, 1_000_000))
    && typeof value.active === 'boolean' && validId(value.version);
}
function parseMoneyText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return 0;
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 100_000_000 ? cents : null;
}

function validSaleInput(value: unknown): value is SaleInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'date', 'paymentMethod', 'fairId', 'status', 'note', 'items'])) return false;
  if (!validUuid(value.requestId) || !isBusinessDate(value.date) || !validPaymentMethod(value.paymentMethod)
    || !validStatus(value.status) || !boundedText(value.note, 500) || !validId(value.fairId)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) return false;
  const seen = new Set<number>();
  return value.items.every(item => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['productId', 'quantity', 'expectedPriceCents', 'expectedName', 'expectedOwnerId', 'expectedOwnerName', 'discountCents', 'feeCents'])) return false;
    if (!validId(item.productId) || seen.has(item.productId as number)
      || !validInteger(item.quantity, 1, 10_000)
      || !validCents(item.expectedPriceCents) || !validCents(item.discountCents) || !validCents(item.feeCents)) return false;
    seen.add(item.productId as number);
    const expectations = [item.expectedName, item.expectedOwnerId, item.expectedOwnerName];
    const expectationCount = expectations.filter(field => field !== undefined).length;
    return (expectationCount === 0 || expectationCount === 3)
      && (item.expectedName === undefined || boundedText(item.expectedName, 100, true) && validId(item.expectedOwnerId)
        && boundedText(item.expectedOwnerName, 100, true));
  });
}

function validDraft(key: string, raw: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return false; }
  if (!isRecord(parsed)) return false;
  const draft = parsed;
  if (draft.version !== 1 && draft.version !== 2) return false;
  const allowed = draft.version === 1
    ? ['version', 'requestId', 'date', 'items', 'method', 'status', 'note']
    : ['version', 'fairId', 'requestId', 'date', 'items', 'method', 'status', 'note', 'catalogExpectations', 'pendingSubmission'];
  if (!hasOnlyKeys(draft, allowed) || !validUuid(draft.requestId) || !isBusinessDate(draft.date)
    || !validPaymentMethod(draft.method) || !validStatus(draft.status) || !boundedText(draft.note, 500)
    || !Array.isArray(draft.items) || draft.items.length > 100) return false;
  if (draft.version === 1) {
    if (key !== 'caixa-feira-draft-v1') return false;
  } else {
    if (!validId(draft.fairId) || key !== `${draftV2Prefix}${draft.fairId}`
      || draft.catalogExpectations !== undefined && typeof draft.catalogExpectations !== 'boolean') return false;
  }
  const cart = new Map<number, { product: Product; quantity: number; discount: string; fee: string }>();
  for (const item of draft.items) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['product', 'quantity', 'discount', 'fee']) || !validProduct(item.product)
      || !validInteger(item.quantity, 1, 10_000)
      || !boundedText(item.discount, 64) || !boundedText(item.fee, 64) || cart.has(item.product.id)) return false;
    cart.set(item.product.id, { product: item.product, quantity: item.quantity, discount: item.discount, fee: item.fee });
  }
  if (draft.pendingSubmission === undefined) return true;
  if (draft.version !== 2 || !validSaleInput(draft.pendingSubmission)) return false;
  const frozen = draft.pendingSubmission;
  if (frozen.requestId !== draft.requestId || frozen.fairId !== draft.fairId || frozen.date !== draft.date
    || frozen.paymentMethod !== draft.method || frozen.status !== draft.status || frozen.note !== draft.note
    || frozen.items.length !== cart.size) return false;
  return frozen.items.every(item => {
    const cartItem = cart.get(item.productId);
    if (!cartItem || item.quantity !== cartItem.quantity || item.expectedPriceCents !== cartItem.product.priceCents) return false;
    const discount = parseMoneyText(cartItem.discount), fee = parseMoneyText(cartItem.fee);
    if (discount === null || fee === null || item.discountCents !== discount || item.feeCents !== fee) return false;
    const hasExpectations = item.expectedName !== undefined;
    return hasExpectations
      ? item.expectedName === cartItem.product.name && item.expectedOwnerId === cartItem.product.ownerId && item.expectedOwnerName === cartItem.product.ownerName
      : true;
  });
}

export function parseWorkspaceState(value: unknown): WorkspaceState {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'date', 'fairId', 'view', 'drafts'])) invalid('estrutura desconhecida.');
  if (value.version !== 1 || !isBusinessDate(value.date) || value.fairId !== null && !validId(value.fairId)
    || typeof value.view !== 'string' || !(workspaceViews as readonly string[]).includes(value.view)) invalid('versão, data, feira ou tela inválida.');
  if (!isRecord(value.drafts)) invalid('rascunhos inválidos.');
  for (const [key, raw] of Object.entries(value.drafts)) {
    const suffix = key.startsWith(draftV2Prefix) ? key.slice(draftV2Prefix.length) : '';
    if (!(key === 'caixa-feira-draft-v1' || /^[1-9]\d*$/.test(suffix))
      || typeof raw !== 'string' || !validDraft(key, raw)) invalid(`rascunho inválido em ${key}.`);
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid('não foi possível serializar.'); }
  if (new TextEncoder().encode(encoded).byteLength > maxWorkspaceBytes) invalid('o estado ultrapassa 1 MiB.');
  return value as unknown as WorkspaceState;
}

