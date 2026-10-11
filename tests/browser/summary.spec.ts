import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../apps/api/dist/database.js';
import { CashRegister } from '../../apps/api/dist/cash-register.js';

const money = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const cash = { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' };

test('consulta produtos, participantes e pedidos de dias fechados sem mudar o dia de trabalho ou os registros', async ({ page, request }, testInfo) => {
  const suffix = randomUUID();
  const firstDate = '2030-06-04', secondDate = '2030-06-05', currentDate = '2030-06-06';
  const previous = await (await request.get('/api/bootstrap?date=' + firstDate)).json();
  if (!previous.fair.closedAt) {
    expect((await request.post(`/api/fairs/${previous.fair.id}/close`, { data: { date: firstDate } })).ok()).toBeTruthy();
  }
  const fairResponse = await request.post('/api/fairs', { data: { name: 'Sumário ' + suffix, targetCents: null, startDate: firstDate } });
  expect(fairResponse.ok()).toBeTruthy();
  const fair = await fairResponse.json();
  const owners = [];
  for (const name of ['Participante A ' + suffix, 'Participante B ' + suffix]) {
    const response = await request.post('/api/owners', { data: { name } });
    expect(response.ok()).toBeTruthy(); owners.push(await response.json());
  }
  const products = [];
  for (const [ownerId, name, priceCents] of [[owners[0].id, 'Biscoito ' + suffix, 2000], [owners[1].id, 'Caneca ' + suffix, 5000]] as const) {
    const response = await request.post('/api/products', { data: { name, description: '', ownerId, priceCents, stock: 20, active: true } });
    expect(response.ok()).toBeTruthy(); products.push(await response.json());
  }
  const createSale = async (date: string, note: string, options: object = {}) => {
    const response = await request.post('/api/sales', { data: { requestId: randomUUID(), fairId: fair.id, date,
      paymentMethod: 'Pix', automaticFees: true, status: 'Pago', note,
      items: [{ productId: products[0].id, quantity: 1, expectedPriceCents: 2000, discountCents: 0, feeCents: 0 }], ...options } });
    expect(response.ok()).toBeTruthy(); return response.json();
  };
  await createSale(firstDate, 'Pedido misto ' + suffix, { paymentMethod: 'Dinheiro',
    payments: [{ paymentMethod: 'Dinheiro', amountCents: 4000 }, { paymentMethod: 'Cartão crédito', cardEntry: 'Aproximação', amountCents: 3000 }],
    items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })) });
  const pending = await createSale(firstDate, 'Pendência recebida depois ' + suffix, { status: 'Pendente' });
  await createSale(firstDate, 'Permuta ' + suffix, { paymentMethod: 'Permuta' });
  await createSale(firstDate, 'Brinde ' + suffix, { paymentMethod: 'Não cobrado',
    items: [{ productId: products[1].id, quantity: 1, expectedPriceCents: 5000, discountCents: 0, feeCents: 0 }] });
  expect((await request.post(`/api/days/${firstDate}/close?fairId=${fair.id}`, { data: { openingCents: 1000,
    extraCents: 500, withdrawalCents: 200, countedCents: 5400, note: 'Contagem guardada\nDiferença de R$ 1,00' } })).ok()).toBeTruthy();
  await createSale(secondDate, 'Pedido do segundo dia ' + suffix);
  expect((await request.post(`/api/sales/${pending.id}/receive?fairId=${fair.id}`, { data: {
    date: secondDate, paymentMethod: 'Dinheiro', automaticFees: true } })).ok()).toBeTruthy();
  const cancelled = await createSale(secondDate, 'Cancelado ' + suffix);
  expect((await request.post(`/api/sales/${cancelled.id}/cancel?fairId=${fair.id}`, { data: {} })).ok()).toBeTruthy();
  expect((await request.post(`/api/days/${secondDate}/close?fairId=${fair.id}`, { data: cash })).ok()).toBeTruthy();
  const beforeEdit = await (await request.get(`/api/bootstrap?date=${currentDate}&fairId=${fair.id}`)).json();
  const product = beforeEdit.products.find((entry: any) => entry.id === products[0].id);
  expect((await request.put('/api/products/' + product.id, { data: { name: product.name + ' atualizado', description: '',
    ownerId: owners[1].id, priceCents: 9999, stock: product.stock, active: true, expectedVersion: product.version } })).ok()).toBeTruthy();
  const before = await (await request.get(`/api/bootstrap?date=${currentDate}&fairId=${fair.id}`)).json();
  expect(before.closedDays).toEqual(beforeEdit.closedDays);
  await page.addInitScript(() => localStorage.setItem('caixa-feira-history-preferences-v1', JSON.stringify({ allDates: true, order: 'date-desc' })));
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.date-field input')).toBeEnabled();
  await page.locator('.date-field input').fill(currentDate);
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  const days = page.getByRole('table', { name: 'Dias fechados da feira' });
  await expect(days.locator('tbody tr')).toHaveCount(2);
  await expect(days.locator('tbody tr').first()).toContainText('05/06/2030');
  await expect(days.locator('tbody tr').last()).toContainText('04/06/2030');
  await expect(page.getByRole('heading', { name: 'Resumo de 05/06/2030', exact: true })).toBeVisible();
  await expect(page.getByTestId('day-net')).toHaveText(money(4000));
  await page.getByRole('button', { name: 'Ver resumo de 04/06/2030', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Resumo de 04/06/2030' });
  await expect(summary.getByTestId('day-net')).toHaveText(money(6907));
  const amounts = summary.getByRole('table', { name: 'Valores por participante' });
  await expect(amounts.getByRole('row').filter({ hasText: owners[0].name }).getByRole('cell')).toHaveText([owners[0].name, money(2000), money(27), money(1973)]);
  await expect(amounts.getByRole('row').filter({ hasText: owners[1].name }).getByRole('cell')).toHaveText([owners[1].name, money(5000), money(66), money(4934)]);
  await expect(summary.locator('.totals > div').filter({ hasText: 'Pendências deste dia' })).toContainText(money(2000));
  await expect(summary.locator('.totals > div').filter({ hasText: 'Permutas / brindes' })).toContainText('1 / 1 unidades');
  await summary.getByText('Conferência de dinheiro guardada', { exact: true }).click();
  await expect(summary.locator('.totals > div').filter({ hasText: 'Dinheiro esperado' })).toContainText(money(5300));
  await expect(summary.locator('.totals > div').filter({ hasText: 'Dinheiro contado' })).toContainText(money(5400));
  await expect(summary.locator('.totals > div').filter({ hasText: 'Diferença' })).toContainText(money(100));
  await expect(summary.locator('.closing-note')).toHaveText('Contagem guardada\nDiferença de R$ 1,00');
  await expect(summary.locator('input, select, textarea')).toHaveCount(0);
  const sold = summary.getByRole('table', { name: 'Produtos vendidos no dia' });
  await expect(sold.locator('tbody tr')).toHaveCount(2);
  await expect(sold.getByRole('row').filter({ hasText: products[0].name }).getByRole('cell')).toHaveText([products[0].name, owners[0].name, '1', money(2000), money(27), money(1973)]);
  await expect(sold.getByRole('row').filter({ hasText: products[1].name }).getByRole('cell')).toHaveText([products[1].name, owners[1].name, '1', money(5000), money(66), money(4934)]);
  const comparison = page.getByRole('table', { name: 'Comparação de produtos por dia' });
  const productCells = comparison.getByRole('row').filter({ hasText: products[0].name }).getByRole('cell');
  await expect(productCells.nth(1)).toContainText('1 un.'); await expect(productCells.nth(1)).toContainText(money(1973));
  await expect(productCells.nth(2)).toContainText('2 un.'); await expect(productCells.nth(2)).toContainText(money(4000));
  await expect(productCells.nth(3)).toHaveText('3'); await expect(productCells.nth(4)).toHaveText(money(6000));
  await expect(productCells.nth(5)).toHaveText(money(27)); await expect(productCells.nth(6)).toHaveText(money(5973));
  const partnerCells = comparison.getByRole('row').filter({ hasText: products[1].name }).getByRole('cell');
  await expect(partnerCells.nth(1)).toContainText('1 un.'); await expect(partnerCells.nth(2)).toContainText('0 un.');
  await expect(partnerCells.nth(3)).toHaveText('1'); await expect(partnerCells.nth(6)).toHaveText(money(4934));
  await expect(comparison).not.toContainText('atualizado');
  const peers = page.getByRole('table', { name: 'Comparação de participantes por dia' });
  await expect(peers.getByRole('row').filter({ hasText: owners[0].name }).getByRole('cell')).toHaveText([owners[0].name, money(1973), money(4000), money(5973)]);
  await page.screenshot({ path: testInfo.outputPath('sumario-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.setViewportSize({ width: 1366, height: 900 });
  await summary.getByRole('button', { name: 'Ver pedidos deste dia', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Mostrar todos os dias' })).not.toBeChecked();
  await expect(page.locator('.history-order')).toHaveCount(4);
  await expect(page.locator('.history-order').filter({ hasText: 'Pedido do segundo dia' })).toHaveCount(0);
  await expect(page.locator('.history-order').filter({ hasText: 'Pedido misto' }).getByRole('button', { name: 'Excluir pedido', exact: true })).toBeDisabled();
  await expect(page.locator('.date-field input')).toHaveValue(currentDate);
  await page.getByRole('combobox', { name: 'Ordenar pedidos' }).selectOption('value-asc');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caixa-feira-history-preferences-v1')!).allDates)).toBe(true);
  // A preferência continua recuperável na mesma instância se o armazenamento falhar.
  await page.evaluate(() => {
    const key = 'caixa-feira-history-preferences-v1';
    const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) { if (name === key) throw new DOMException('Bloqueado', 'SecurityError'); return getItem.call(this, name); };
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Bloqueado', 'QuotaExceededError'); return setItem.call(this, name, value); };
  });
  await page.getByRole('combobox', { name: 'Ordenar pedidos' }).selectOption('value-desc');
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  // A consulta temporária não substitui a preferência habitual de todos os dias.
  await expect(page.getByRole('checkbox', { name: 'Mostrar todos os dias' })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Ordenar pedidos' })).toHaveValue('value-desc');
  await expect(page.locator('.history-order')).toHaveCount(6);
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  await page.getByRole('button', { name: 'Ver resumo de 04/06/2030', exact: true }).click();
  await page.getByRole('button', { name: 'Ver pedidos deste dia', exact: true }).click();
  await page.getByRole('button', { name: 'Usar data de trabalho', exact: true }).click();
  await expect(page.locator('.history-order')).toHaveCount(0);
  await expect(page.locator('.date-field input')).toHaveValue(currentDate);
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exportar dias desta feira', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('fechamentos.csv');
  const after = await (await request.get(`/api/bootstrap?date=${currentDate}&fairId=${fair.id}`)).json();
  expect(after).toEqual(before); expect(writes).toEqual([]);
  expect((await request.post(`/api/fairs/${fair.id}/close`, { data: { date: currentDate } })).ok()).toBeTruthy();
  const nextResponse = await request.post('/api/fairs', { data: { name: 'Próxima do sumário ' + suffix, targetCents: null, startDate: currentDate } });
  expect(nextResponse.ok()).toBeTruthy(); const next = await nextResponse.json();
  await page.reload();
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  await expect(page.getByText(/Nenhum dia fechado nesta feira/)).toBeVisible();
  await expect(page.getByRole('region', { name: /Resumo de/ })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Feira', exact: true }).selectOption({ label: fair.name + ' · Encerrada' });
  await expect(page.getByRole('table', { name: 'Dias fechados da feira' }).locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('region', { name: /Resumo de/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Feira', exact: true }).selectOption({ label: next.name + ' · Ativa' });
  await expect(page.getByText(/Nenhum dia fechado nesta feira/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'Comparação de produtos por dia' })).toHaveCount(0);
});

test('sumário e comparação mostram taxas retificadas e preservam o fechamento original', async ({ page }) => {
  // Bootstrap real de um banco em memória: valida a apresentação do contrato de
  // retificação sem criar uma rota de alteração nem modificar o banco do servidor.
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?),(2,?)').run('Con Affetto retificação', 'Participante retificação');
    const register = new CashRegister(db);
    const products = [2000, 5000].map((priceCents, index) => register.saveProduct({ name: 'Produto retificado ' + index,
      ownerId: index + 1, priceCents, stock: 10, active: true, description: '' }));
    const date = '2032-06-01';
    register.createSale({ requestId: randomUUID(), date, paymentMethod: 'Cartão crédito', status: 'Pago', note: '',
      items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })) });
    register.closeDay(date, cash);
    const original = db.prepare('SELECT snapshot FROM days WHERE date=?').get(date).snapshot;
    register.correctPastCardFees('Taxas confirmadas da fixture');
    const currentProduct = register.products().find(product => product.id === products[0].id)!;
    const updated = register.saveProduct({ name: 'Produto reatribuído', ownerId: 2, priceCents: 3000, stock: currentProduct.stock,
      active: true, description: '', expectedVersion: currentProduct.version }, currentProduct.id);
    register.createSale({ requestId: randomUUID(), date: '2032-06-02', paymentMethod: 'Dinheiro', status: 'Pago', automaticFees: true, note: '',
      items: [{ productId: updated.id, quantity: 1, expectedPriceCents: updated.priceCents, discountCents: 0, feeCents: 0 }] });
    register.closeDay('2032-06-02', cash);
    await page.route('**/api/bootstrap?*', async route => {
      const date = new URL(route.request().url()).searchParams.get('date')!;
      await route.fulfill({ json: register.bootstrap(date) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Sumário', exact: true }).click();
    await page.getByRole('button', { name: 'Ver resumo de 01/06/2032', exact: true }).click();
    const summary = page.getByRole('region', { name: 'Resumo de 01/06/2032' });
    await expect(summary.getByTestId('day-net')).toHaveText(money(6784));
    await expect(summary.locator('.alert')).toContainText('líquido no fechamento original ' + money(7000));
    await expect(summary.locator('.alert')).toContainText('taxas acrescentadas ' + money(216));
    const row = page.getByRole('table', { name: 'Dias fechados da feira' }).getByRole('row').filter({ hasText: '01/06/2032' });
    await expect(row).toContainText('Retificado'); await expect(row).toContainText(money(216)); await expect(row).toContainText(money(6784));
    const sold = summary.getByRole('table', { name: 'Produtos vendidos no dia' });
    await expect(sold.getByRole('row').filter({ hasText: products[0].name }).getByRole('cell')).toHaveText([products[0].name, 'Con Affetto retificação', '1', money(2000), money(62), money(1938)]);
    await expect(sold.getByRole('row').filter({ hasText: products[1].name }).getByRole('cell')).toHaveText([products[1].name, 'Participante retificação', '1', money(5000), money(154), money(4846)]);
    const peers = page.getByRole('table', { name: 'Comparação de participantes por dia' });
    await expect(peers.getByRole('row').filter({ hasText: 'Con Affetto retificação' }).getByRole('cell')).toHaveText(['Con Affetto retificação', money(1938), money(0), money(1938)]);
    const comparison = page.getByRole('table', { name: 'Comparação de produtos por dia' });
    await expect(comparison.locator('tbody tr')).toHaveCount(3);
    await expect(comparison.getByRole('row').filter({ hasText: products[0].name })).toContainText('Con Affetto retificação');
    await expect(comparison.getByRole('row').filter({ hasText: updated.name })).toContainText('Participante retificação');
    await page.getByRole('button', { name: 'Ver resumo de 02/06/2032', exact: true }).click();
    const nextSold = page.getByRole('region', { name: 'Resumo de 02/06/2032' }).getByRole('table', { name: 'Produtos vendidos no dia' });
    await expect(nextSold.getByRole('row').filter({ hasText: updated.name }).getByRole('cell')).toHaveText([updated.name, 'Participante retificação', '1', money(3000), money(0), money(3000)]);
    await page.locator('.date-field input').fill(date);
    await page.getByRole('button', { name: 'Fechamento', exact: true }).click();
    await expect(page.getByTestId('day-net')).toHaveText(money(6784));
    await expect(page.locator('.closing-list')).toContainText(money(6784));
    expect(db.prepare('SELECT snapshot FROM days WHERE date=?').get(date).snapshot).toBe(original);
    await page.unroute('**/api/bootstrap?*');
  } finally { db.close(); }
});
