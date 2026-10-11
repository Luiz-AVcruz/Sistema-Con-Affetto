import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const preferencesKey = 'caixa-feira-history-preferences-v1';
const nextDate = (date: string, days: number) => {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

test('histórico filtra o dia, ordena por valor/data e lembra as escolhas ao reabrir', async ({ page, request, context }) => {
  await page.goto('/');
  await expect(page.locator('.date-field input')).toBeEnabled();
  const today = await page.locator('.date-field input').inputValue();
  const selected = nextDate(today, 1), newest = nextDate(today, 2);
  const data = await (await request.get('/api/bootstrap?date=' + today)).json();
  const owner = await (await request.post('/api/owners', { data: { name: 'Histórico ' + randomUUID() } })).json();
  const productResponse = await request.post('/api/products', { data: {
    name: 'Produto para ordenar', description: '', ownerId: owner.id, priceCents: 1000, stock: null, active: true
  } });
  expect(productResponse.ok()).toBeTruthy();
  const product = await productResponse.json();
  const prefix = 'Ordenação teste: ';
  let pendingId = '';
  const fixtures = [
    { name: 'Maior', date: selected, quantity: 12 },
    { name: 'Menor', date: selected, quantity: 1 },
    { name: 'Permuta', date: selected, quantity: 1, paymentMethod: 'Permuta' },
    { name: 'Mais novo', date: newest, quantity: 2 },
    // Criados depois dos pedidos futuros: a ordenação deve respeitar o dia do pedido.
    { name: 'Mais antigo', date: today, quantity: 3 },
    { name: 'Pendência anterior', date: today, quantity: 1, status: 'Pendente' },
    { name: 'Recebido no dia', date: today, quantity: 2, status: 'Pendente' }
  ];
  for (const fixture of fixtures) {
    const response = await request.post('/api/sales', { data: {
      requestId: randomUUID(), fairId: data.fair.id, date: fixture.date,
      paymentMethod: fixture.paymentMethod ?? 'Dinheiro', status: fixture.status ?? 'Pago', note: prefix + fixture.name,
      items: [{ productId: product.id, quantity: fixture.quantity, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 }]
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const sale = await response.json();
    if (fixture.name === 'Pendência anterior') pendingId = sale.id;
    if (fixture.name === 'Recebido no dia') {
      expect((await request.post(`/api/sales/${sale.id}/receive?fairId=${data.fair.id}`, {
        data: { date: selected, paymentMethod: 'Pix' }
      })).ok()).toBeTruthy();
    }
    // Separa os instantes reais de registro, mesmo numa máquina muito rápida.
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await page.locator('.date-field input').fill(selected);
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  const allDates = page.getByRole('checkbox', { name: 'Mostrar todos os dias' });
  const order = page.getByRole('combobox', { name: 'Ordenar pedidos' });
  const notes = page.locator('.history-order').filter({ hasText: prefix }).locator(':scope > p.muted');
  const names = (...values: string[]) => values.map(value => prefix + value);
  await expect(allDates).not.toBeChecked();
  await expect(order).toHaveValue('date-desc');
  await expect(notes).toHaveText(names('Permuta', 'Menor', 'Maior', 'Recebido no dia'));
  await allDates.check();
  await expect(notes).toHaveText(names('Mais novo', 'Permuta', 'Menor', 'Maior', 'Recebido no dia', 'Pendência anterior', 'Mais antigo'));
  await order.selectOption('date-asc');
  await expect(notes).toHaveText(names('Mais antigo', 'Pendência anterior', 'Recebido no dia', 'Maior', 'Menor', 'Permuta', 'Mais novo'));
  await order.selectOption('value-desc');
  await expect(notes).toHaveText(names('Maior', 'Mais antigo', 'Mais novo', 'Recebido no dia', 'Menor', 'Pendência anterior', 'Permuta'));
  await order.selectOption('value-asc');
  await expect(notes).toHaveText(names('Permuta', 'Menor', 'Pendência anterior', 'Mais novo', 'Recebido no dia', 'Mais antigo', 'Maior'));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(allDates).toBeChecked();
  await expect(order).toHaveValue('value-asc');
  await allDates.uncheck();
  await page.getByRole('button', { name: 'Produtos', exact: true }).click();
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(allDates).not.toBeChecked();
  await expect(order).toHaveValue('value-asc');
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await reopened.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(reopened.getByRole('checkbox', { name: 'Mostrar todos os dias' })).not.toBeChecked();
  await expect(reopened.getByRole('combobox', { name: 'Ordenar pedidos' })).toHaveValue('value-asc');
  // O banco temporário é compartilhado: a pendência deste teste não deve impedir
  // que o teste de encerramento valide sua própria feira.
  expect((await request.post(`/api/sales/${pendingId}/cancel?fairId=${data.fair.id}`, { data: {} })).ok()).toBeTruthy();
});

test('preferências inválidas ou armazenamento indisponível não impedem consultar o histórico', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  for (const value of ['{incompleto', JSON.stringify({ allDates: 'sim', order: 'desconhecido' })]) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: preferencesKey, value });
    await page.reload();
    await page.getByRole('button', { name: 'Histórico', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Mostrar todos os dias' })).not.toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Ordenar pedidos' })).toHaveValue('date-desc');
  }
  await page.getByRole('button', { name: 'Produtos', exact: true }).click();
  await page.evaluate(key => {
    const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Armazenamento bloqueado', 'SecurityError');
      return getItem.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Armazenamento bloqueado', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  }, preferencesKey);
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Mostrar todos os dias' }).check();
  await page.getByRole('combobox', { name: 'Ordenar pedidos' }).selectOption('value-desc');
  await expect(page.getByRole('checkbox', { name: 'Mostrar todos os dias' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Ordenar pedidos' })).toHaveValue('value-desc');
  expect(errors).toEqual([]);
});
