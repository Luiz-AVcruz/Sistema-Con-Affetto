export const formatMoney = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
export const moneyInput = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
export const formatDay = (date: string) => date.split('-').reverse().join('/');
export const formatRegisteredAt = (instant: string) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(instant));
export function localDate(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}
export function parseMoney(value: string): number {
  const normalized = String(value).trim();
  if (!normalized) return 0;
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(normalized)) throw new Error('Informe o valor como 12,50, com até duas casas decimais.');
  const [whole, decimal = ''] = normalized.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw new Error('Valor fora do limite permitido.');
  return cents;
}
