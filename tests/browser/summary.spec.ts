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
  const comparison = page.getByRole('table', { name: 'Comparação de produtos por período' });
  const productCells = comparison.getByRole('row').filter({ hasText: products[0].name }).getByRole('cell');
  await expect(productCells.nth(1)).toContainText('1 un.'); await expect(productCells.nth(1)).toContainText(money(1973));
  await expect(productCells.nth(2)).toContainText('2 un.'); await expect(productCells.nth(2)).toContainText(money(4000));
  await expect(productCells.nth(3)).toHaveText('3'); await expect(productCells.nth(4)).toHaveText(money(6000));
  await expect(productCells.nth(5)).toHaveText(money(27)); await expect(productCells.nth(6)).toHaveText(money(5973));
  const partnerCells = comparison.getByRole('row').filter({ hasText: products[1].name }).getByRole('cell');
  await expect(partnerCells.nth(1)).toContainText('1 un.'); await expect(partnerCells.nth(2)).toContainText('0 un.');
  await expect(partnerCells.nth(3)).toHaveText('1'); await expect(partnerCells.nth(6)).toHaveText(money(4934));
  await expect(comparison).not.toContainText('atualizado');
  const peers = page.getByRole('table', { name: 'Comparação de participantes por período' });
  const ownerCells = peers.getByRole('row').filter({ hasText: owners[0].name }).getByRole('cell');
  await expect(ownerCells.nth(1)).toContainText('1 un.'); await expect(ownerCells.nth(1)).toContainText(money(1973));
  await expect(ownerCells.nth(2)).toContainText('2 un.'); await expect(ownerCells.nth(2)).toContainText(money(4000));
  await expect(ownerCells.nth(3)).toHaveText('3'); await expect(ownerCells.nth(4)).toHaveText(money(6000));
  await expect(ownerCells.nth(5)).toHaveText(money(27)); await expect(ownerCells.nth(6)).toHaveText(money(5973));
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
  await expect(page.getByRole('table', { name: 'Comparação de produtos por período' })).toHaveCount(0);
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
    const peers = page.getByRole('table', { name: 'Comparação de participantes por período' });
    const ownerCells = peers.getByRole('row').filter({ hasText: 'Con Affetto retificação' }).getByRole('cell');
    await expect(ownerCells.nth(1)).toContainText('1 un.'); await expect(ownerCells.nth(1)).toContainText(money(1938));
    await expect(ownerCells.nth(2)).toContainText('0 un.'); await expect(ownerCells.nth(2)).toContainText(money(0));
    await expect(ownerCells.nth(3)).toHaveText('1'); await expect(ownerCells.nth(4)).toHaveText(money(2000));
    await expect(ownerCells.nth(5)).toHaveText(money(62)); await expect(ownerCells.nth(6)).toHaveText(money(1938));
    const comparison = page.getByRole('table', { name: 'Comparação de produtos por período' });
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

test('escolhe períodos, produtos, participantes e métricas, sem preencher dias vazios nem alterar fechamentos', async ({ page }, testInfo) => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('UPDATE fairs SET start_date=? WHERE id=1').run('2026-10-08');
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?),(2,?)').run('Con Affetto comparação', 'Parceiro comparação');
    const register = new CashRegister(db);
    const products = [2000, 5000].map((priceCents, index) => register.saveProduct({
      name: index ? 'Caneca comparação' : 'Biscoito comparação', ownerId: index + 1, priceCents, stock: 100, active: true, description: ''
    }));
    const sale = (date: string, index: number, quantity = 1, options: object = {}) => register.createSale({
      requestId: randomUUID(), date, paymentMethod: 'Pix', status: 'Pago', automaticFees: true, note: '',
      items: [{ productId: products[index].id, quantity, expectedPriceCents: products[index].priceCents, discountCents: 0, feeCents: 0 }], ...options
    });
    sale('2026-10-09', 0, 1, { paymentMethod: 'Dinheiro',
      payments: [{ paymentMethod: 'Dinheiro', amountCents: 4000 }, { paymentMethod: 'Cartão crédito', cardEntry: 'Aproximação', amountCents: 3000 }],
      items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 }))
    });
    const pending = sale('2026-10-09', 0, 1, { status: 'Pendente' });
    register.closeDay('2026-10-09', cash);
    sale('2026-10-10', 0, 2);
    const cancelled = sale('2026-10-10', 0);
    register.cancelSale(cancelled.id);
    register.receiveSale(pending.id, '2026-10-11', 'Pix', { automaticFees: true });
    sale('2026-10-16', 0, 1, { paymentMethod: 'Cartão crédito', cardEntry: 'Aproximação' });
    sale('2026-10-17', 1, 1, { paymentMethod: 'Dinheiro' });
    sale('2026-10-18', 0, 1, { paymentMethod: 'Permuta' });
    sale('2026-10-23', 0, 3);
    sale('2026-10-25', 1, 2);
    register.saveDay('2026-10-12', cash);
    register.saveDay('2026-10-13', { ...cash, countedCents: 0 });
    register.saveDay('2026-10-14', { ...cash, note: 'Observação sem vendas' });
    register.saveDay('2026-10-24', cash);
    // Apenas consultar uma data sem feira não cria um fechamento.
    register.day('2026-10-15');
    register.closeFair('2026-10-25');
    const before = register.bootstrap('2026-10-25');
    expect(before.closedDays).toHaveLength(13);
    expect(before.closedDays.some(day => day.date === '2026-10-15')).toBe(false);
    const originals = db.prepare('SELECT date,snapshot FROM days WHERE fair_id=1 ORDER BY date').all();
    await page.route('**/api/bootstrap?*', async route => {
      const params = new URL(route.request().url()).searchParams;
      await route.fulfill({ json: new CashRegister(db, params.has('fairId') ? Number(params.get('fairId')) : undefined).bootstrap(params.get('date')!) });
    });
    const writes: string[] = [];
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
    await page.goto('/');
    await page.locator('.date-field input').fill('2026-10-25');
    await page.getByRole('button', { name: 'Sumário', exact: true }).click();
    const days = page.getByRole('table', { name: 'Dias fechados da feira' });
    await expect(days.locator('tbody tr')).toHaveCount(10);
    await expect(days).not.toContainText('08/10/2026'); await expect(days).not.toContainText('12/10/2026');
    await expect(days).not.toContainText('24/10/2026'); await expect(days).not.toContainText('15/10/2026');
    await expect(days).toContainText('13/10/2026'); await expect(days).toContainText('14/10/2026');
    await expect(days).toContainText('18/10/2026');
    await page.getByRole('checkbox', { name: 'Mostrar fechamentos vazios', exact: true }).check();
    await expect(days.locator('tbody tr')).toHaveCount(13);
    const totals = page.getByRole('table', { name: 'Resumo dos períodos comparados' });
    await expect(totals.getByRole('row').filter({ hasText: '12/10/2026' }).getByRole('cell')).toHaveText([
      '12/10/2026', '0', '0', money(0), money(0), money(0), 'Sem venda paga'
    ]);
    await page.getByRole('checkbox', { name: 'Mostrar fechamentos vazios', exact: true }).uncheck();
    for (const date of ['13/10/2026', '14/10/2026']) await page.getByRole('checkbox', { name: 'Comparar ' + date, exact: true }).uncheck();
    await page.getByRole('combobox', { name: 'Agrupar comparação', exact: true }).selectOption('week');
    await expect(totals.locator('tbody tr')).toHaveCount(3);
    for (const expected of [
      ['09/10/2026 a 11/10/2026', '5', '3', money(13000), money(93), money(12907), money(4333)],
      ['16/10/2026 a 18/10/2026', '2', '2', money(7000), money(62), money(6938), money(3500)],
      ['23/10/2026 a 25/10/2026', '5', '2', money(16000), money(0), money(16000), money(8000)]
    ]) await expect(totals.getByRole('row').filter({ hasText: expected[0] }).getByRole('cell')).toHaveText(expected);
    const comparison = page.getByRole('table', { name: 'Comparação de produtos por período' });
    const peers = page.getByRole('table', { name: 'Comparação de participantes por período' });
    const cookie = comparison.getByRole('row').filter({ hasText: 'Biscoito comparação' }).getByRole('cell');
    await expect(cookie.nth(1)).toContainText('4 un.'); await expect(cookie.nth(1)).toContainText(money(7973));
    await expect(cookie.nth(2)).toContainText('1 un.'); await expect(cookie.nth(2)).toContainText(money(1938));
    await expect(cookie.nth(3)).toContainText('3 un.'); await expect(cookie.nth(3)).toContainText(money(6000));
    await expect(cookie.nth(4)).toHaveText('8'); await expect(cookie.nth(5)).toHaveText(money(16000));
    await expect(cookie.nth(6)).toHaveText(money(89)); await expect(cookie.nth(7)).toHaveText(money(15911));
    const mug = comparison.getByRole('row').filter({ hasText: 'Caneca comparação' }).getByRole('cell');
    for (const [metric, value] of [['received', money(5000)], ['net', money(4934)], ['fees', money(66)], ['units', '1 un.']]) {
      await page.getByRole('combobox', { name: 'Valores por período', exact: true }).selectOption(metric);
      await expect(mug.nth(1)).toHaveText(value);
    }
    for (const [order, first] of [['units-asc', 'Caneca comparação'], ['net-desc', 'Caneca comparação'], ['net-asc', 'Biscoito comparação'], ['units-desc', 'Biscoito comparação']]) {
      await page.getByRole('combobox', { name: 'Ordenar comparação', exact: true }).selectOption(order);
      await expect(comparison.locator('tbody tr').first()).toContainText(first);
    }
    await page.getByRole('button', { name: 'Limpar dias da comparação', exact: true }).click();
    await expect(totals).toHaveCount(0); await expect(comparison).toHaveCount(0);
    await expect(page.getByText(/Nenhum dia escolhido para comparar/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Resumo de 25/10/2026', exact: true }).getByTestId('day-net')).toHaveText(money(10000));
    for (const date of ['09/10/2026', '16/10/2026']) await page.getByRole('checkbox', { name: 'Comparar ' + date, exact: true }).check();
    await expect(totals.locator('tbody tr')).toHaveCount(2);
    await expect(cookie.nth(3)).toHaveText('2'); await expect(cookie.nth(4)).toHaveText(money(4000));
    await expect(cookie.nth(5)).toHaveText(money(89)); await expect(cookie.nth(6)).toHaveText(money(3911));
    await expect(mug.nth(2)).toHaveText('0 un.'); // Produto sem venda no período permanece comparável.
    await page.getByText('Escolher produtos e participantes', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Comparar participante Con Affetto comparação', exact: true }).uncheck();
    await expect(comparison.locator('tbody tr')).toHaveCount(1); await expect(peers.locator('tbody tr')).toHaveCount(1);
    await expect(totals.locator('tbody tr').first().getByRole('cell').nth(3)).toHaveText(money(7000));
    await page.getByRole('button', { name: 'Limpar produtos', exact: true }).click();
    await expect(comparison).toHaveCount(0); await expect(peers.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('button', { name: 'Todos os produtos', exact: true }).click();
    await page.getByRole('button', { name: 'Todos os participantes', exact: true }).click();
    await expect(comparison.locator('tbody tr')).toHaveCount(2); await expect(peers.locator('tbody tr')).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Comparar produto Biscoito comparação · Con Affetto comparação', exact: true }).uncheck();
    await expect(comparison.locator('tbody tr')).toHaveCount(1); await expect(peers.locator('tbody tr')).toHaveCount(2);
    await page.getByRole('combobox', { name: 'Comparar', exact: true }).selectOption('products');
    await expect(comparison).toHaveCount(1); await expect(peers).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Comparar', exact: true }).selectOption('owners');
    await expect(comparison).toHaveCount(0); await expect(peers).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Comparar', exact: true }).selectOption('both');
    await page.getByRole('combobox', { name: 'Valores por período', exact: true }).selectOption('net');
    await page.getByRole('combobox', { name: 'Ordenar comparação', exact: true }).selectOption('net-desc');
    await expect(page.locator('.date-field input')).toHaveValue('2026-10-25');
    await page.screenshot({ path: testInfo.outputPath('comparacoes-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole('button', { name: 'Histórico', exact: true }).click();
    await page.getByRole('button', { name: 'Sumário', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Agrupar comparação', exact: true })).toHaveValue('week');
    await expect(comparison.locator('tbody tr')).toHaveCount(1);
    await page.reload();
    await page.getByRole('button', { name: 'Sumário', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Valores por período', exact: true })).toHaveValue('net');
    await expect(page.getByRole('combobox', { name: 'Ordenar comparação', exact: true })).toHaveValue('net-desc');
    await expect(totals.locator('tbody tr')).toHaveCount(2); await expect(comparison.locator('tbody tr')).toHaveCount(1);
    expect(register.bootstrap('2026-10-25')).toEqual(before);
    const next = register.createFair({ name: 'Próxima comparação', targetCents: null, startDate: '2026-10-26' });
    const nextRegister = new CashRegister(db, next.id);
    nextRegister.createSale({ requestId: randomUUID(), date: '2026-10-26', paymentMethod: 'Pix', status: 'Pago', automaticFees: true, note: '',
      items: [{ productId: products[0].id, quantity: 1, expectedPriceCents: 2000, discountCents: 0, feeCents: 0 }] });
    nextRegister.closeDay('2026-10-26', cash);
    await page.evaluate(id => localStorage.setItem('caixa-feira-comparisons-v1-' + id, JSON.stringify({
      dates: 'invalid', ownerIds: [null], productKeys: [4], grouping: 'invalid', metric: 'invalid', order: 'invalid', target: 'invalid', showEmpty: 'invalid'
    })), next.id);
    await page.reload();
    await page.getByRole('button', { name: 'Sumário', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Valores por período', exact: true })).toHaveValue('units-net');
    await expect(page.getByRole('combobox', { name: 'Agrupar comparação', exact: true })).toHaveValue('day');
    await expect(page.getByRole('combobox', { name: 'Comparar', exact: true })).toHaveValue('both');
    await expect(page.getByRole('checkbox', { name: 'Mostrar fechamentos vazios', exact: true })).not.toBeChecked();
    await expect(totals.locator('tbody tr')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Feira', exact: true }).selectOption({ label: before.fair.name + ' · Encerrada' });
    await expect(page.getByRole('combobox', { name: 'Agrupar comparação', exact: true })).toHaveValue('week');
    await expect(page.getByRole('combobox', { name: 'Valores por período', exact: true })).toHaveValue('net');
    await expect(totals.locator('tbody tr')).toHaveCount(2); await expect(comparison.locator('tbody tr')).toHaveCount(1);
    expect(db.prepare('SELECT date,snapshot FROM days WHERE fair_id=1 ORDER BY date').all()).toEqual(originals);
    expect(writes).toEqual([]);
    await page.unroute('**/api/bootstrap?*');
  } finally { db.close(); }
});
