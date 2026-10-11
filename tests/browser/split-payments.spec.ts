import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function setup(page: Page, request: APIRequestContext, prefix: string) {
  const suffix = randomUUID();
  await page.goto('/');
  await expect(page.locator('.date-field input')).toBeEnabled();
  let date = await page.locator('.date-field input').inputValue();
  let context = await (await request.get('/api/bootstrap?date=' + date)).json();
  if (context.fair.closedAt) {
    date = [date,context.fair.endDate].filter(Boolean).sort().at(-1)!;
    const created = await request.post('/api/fairs', { data: { name: `Feira divisão ${suffix}`, targetCents: null, startDate: date } });
    expect(created.ok()).toBeTruthy();
    context = await (await request.get('/api/bootstrap?date=' + date)).json();
  }
  date = [date,context.fair.startDate].sort().at(-1)!;
  context = await (await request.get('/api/bootstrap?date=' + date)).json();
  while (context.day.closedAt) {
    const next = new Date(date + 'T12:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0,10);
    context = await (await request.get('/api/bootstrap?date=' + date)).json();
  }
  const company = await (await request.post('/api/owners', { data: { name: `Con Affetto ${suffix}` } })).json();
  const partner = await (await request.post('/api/owners', { data: { name: `Participante ${suffix}` } })).json();
  const companyProduct = await (await request.post('/api/products', { data: {
    name: `${prefix} Con Affetto ${suffix}`, description: '', ownerId: company.id, priceCents: 3200, stock: 10, active: true
  } })).json();
  const partnerProduct = await (await request.post('/api/products', { data: {
    name: `${prefix} participante ${suffix}`, description: '', ownerId: partner.id, priceCents: 5000, stock: 10, active: true
  } })).json();
  await page.goto('/');
  await expect(page.locator('.date-field input')).toBeEnabled();
  if (await page.locator('.date-field input').inputValue() !== date) await page.locator('.date-field input').fill(date);
  const data = await (await request.get('/api/bootstrap?date=' + date)).json();
  await page.getByRole('button', { name: `Adicionar ${companyProduct.name}`, exact: true }).click();
  await page.getByRole('button', { name: `Adicionar ${partnerProduct.name}`, exact: true }).click();
  return { company, partner, companyProduct, partnerProduct, date, fairId: data.fair.id, baseline: data.day.summary };
}

async function chooseSplit(page: Page) {
  await page.getByRole('checkbox', { name: 'Dividir em duas formas de pagamento' }).check();
  await page.getByRole('combobox', { name: 'Segundo pagamento', exact: true }).selectOption('Cartão crédito');
  await page.getByRole('textbox', { name: 'Valor do primeiro pagamento (R$)', exact: true }).fill('0,00');
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Valor do primeiro pagamento (R$)', exact: true }).fill('82,00');
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Valor do primeiro pagamento (R$)', exact: true }).fill('50,00');
  await expect(page.getByTestId('second-payment-total')).toContainText('32,00');
  await expect(page.getByTestId('cart-fee')).toContainText('0,99');
  await expect(page.getByTestId('cart-net')).toContainText('81,01');
}

test('registra um pedido com duas formas, preserva o rascunho e mostra cada pagamento no histórico', async ({ page, request }) => {
  const f = await setup(page, request, 'Divisão');
  await chooseSplit(page);
  await page.reload();
  await expect(page.locator('.date-field input')).toBeEnabled();
  if (await page.locator('.date-field input').inputValue() !== f.date) await page.locator('.date-field input').fill(f.date);
  await expect(page.getByRole('checkbox', { name: 'Dividir em duas formas de pagamento' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Segundo pagamento', exact: true })).toHaveValue('Cartão crédito');
  await expect(page.getByRole('textbox', { name: 'Valor do primeiro pagamento (R$)', exact: true })).toHaveValue('50,00');
  await expect(page.getByTestId('cart-fee')).toContainText('0,99');
  await expect(page.getByTestId('cart-net')).toContainText('81,01');

  const response = page.waitForResponse(r => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  const savedResponse = await response;
  expect(savedResponse.ok()).toBeTruthy();
  const saved = await savedResponse.json();
  expect(saved.paymentMethod).toBe('Dinheiro');
  expect(saved.payments).toEqual([
    { paymentMethod: 'Dinheiro', amountCents: 5000, cardEntry: null, feeCents: 0, netCents: 5000 },
    { paymentMethod: 'Cartão crédito', amountCents: 3200, cardEntry: 'Aproximação', feeCents: 99, netCents: 3101 }
  ]);
  expect(saved.totalCents).toBe(8200);
  expect(saved.feeCents).toBe(99);
  expect(saved.netCents).toBe(8101);
  expect(saved.items.map((item: any) => [item.ownerId, item.feeCents])).toEqual([
    [f.company.id, 39], [f.partner.id, 60]
  ]);
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  await expect(page.getByRole('checkbox', { name: 'Dividir em duas formas de pagamento' })).not.toBeChecked();

  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.sales.filter((sale: any) => sale.id === saved.id)).toHaveLength(1);
  expect(data.day.summary.paidCount - f.baseline.paidCount).toBe(1);
  expect(data.day.summary.feeCents - f.baseline.feeCents).toBe(99);
  expect(data.day.summary.netCents - f.baseline.netCents).toBe(8101);
  expect(data.day.summary.byPayment.find((entry: any) => entry.method === 'Dinheiro')!.totalCents
    - f.baseline.byPayment.find((entry: any) => entry.method === 'Dinheiro')!.totalCents).toBe(5000);
  expect(data.day.summary.byPayment.find((entry: any) => entry.method === 'Cartão crédito')!.totalCents
    - f.baseline.byPayment.find((entry: any) => entry.method === 'Cartão crédito')!.totalCents).toBe(3200);
  expect(data.products.find((product: any) => product.id === f.companyProduct.id).stock).toBe(9);
  expect(data.products.find((product: any) => product.id === f.partnerProduct.id).stock).toBe(9);

  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  const order = page.locator('.history-order').filter({ hasText: f.companyProduct.name });
  await expect(order).toContainText('2 formas de pagamento');
  await expect(order).toContainText('Dinheiro');
  await expect(order).toContainText('Cartão crédito (aproximação)');
  await expect(order).toContainText('R$ 50,00');
  await expect(order).toContainText('R$ 32,00');
  await expect(order).toContainText('Taxa R$ 0,00');
  await expect(order).toContainText('Taxa R$ 0,99');
});

test('resposta perdida conserva o payload dividido e o retry não duplica o pedido', async ({ page, request }) => {
  const f = await setup(page, request, 'Retry dividido');
  await chooseSplit(page);
  let original: any;
  await page.route('**/api/sales', async route => {
    original = route.request().postDataJSON();
    const committed = await route.fetch();
    expect(committed.ok()).toBeTruthy();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar');
  await page.unroute('**/api/sales');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Dividir em duas formas de pagamento' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Segundo pagamento', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Valor do primeiro pagamento (R$)', exact: true })).toHaveValue('50,00');

  const retry = page.waitForRequest(r => r.url().endsWith('/api/sales') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  expect((await retry).postDataJSON()).toEqual(original);
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.sales.filter((sale: any) => sale.id === original.requestId)).toHaveLength(1);
  expect(data.sales.find((sale: any) => sale.id === original.requestId).payments.map((payment: any) => ({
    paymentMethod: payment.paymentMethod, amountCents: payment.amountCents, cardEntry: payment.cardEntry
  }))).toEqual(original.payments.map((payment: any) => ({
    paymentMethod: payment.paymentMethod, amountCents: payment.amountCents, cardEntry: payment.cardEntry ?? null
  })));
  expect(data.products.find((product: any) => product.id === f.companyProduct.id).stock).toBe(9);
  expect(data.products.find((product: any) => product.id === f.partnerProduct.id).stock).toBe(9);
});
