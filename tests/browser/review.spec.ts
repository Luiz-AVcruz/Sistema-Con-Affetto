import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function setup(page: Page, request: APIRequestContext, label: string) {
  const ownerA = await (await request.post('/api/owners', { data: { name: `${label} A` } })).json();
  const ownerB = await (await request.post('/api/owners', { data: { name: `${label} B` } })).json();
  const product = await (await request.post('/api/products', { data: { name: label, description: '', ownerId: ownerA.id, priceCents: 1500, stock: 10, active: true } })).json();
  await page.goto('/');
  await page.getByRole('button', { name: `Adicionar ${label}`, exact: true }).click();
  const date = await page.locator('.date-field input').inputValue();
  const data = await (await request.get('/api/bootstrap?date=' + date)).json();
  return { ownerA, ownerB, product, date, fairId: data.fair.id };
}
async function submit(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  const saved = await response; expect(saved.ok()).toBeTruthy();
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  return saved;
}
async function editThroughUi(page: Page, name: string, owner: string, price: string) {
  await page.getByRole('button', { name: 'Produtos', exact: true }).click();
  await page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('combobox', { name: 'Participante', exact: true }).selectOption({ label: owner });
  await page.getByRole('textbox', { name: 'Preço (R$)', exact: true }).fill(price);
  await page.getByRole('button', { name: 'Salvar produto', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Produto salvo.' })).toBeVisible();
  await page.getByRole('button', { name: 'Vender', exact: true }).click();
}

test('desconto e taxa automática são zerados ao trocar para permuta ou brinde', async ({ page, request }) => {
  const f = await setup(page, request, 'Ajustes de teste');
  for (const method of ['Permuta', 'Não cobrado']) {
    if (method === 'Não cobrado') await page.getByRole('button', { name: 'Adicionar Ajustes de teste', exact: true }).click();
    await page.getByText('Desconto deste item', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Desconto (R$)', exact: true }).fill('1,00');
    await page.getByRole('combobox', { name: 'Pagamento', exact: true }).selectOption('Cartão crédito');
    await expect(page.getByTestId('cart-fee')).toContainText('0,43');
    await page.getByRole('combobox', { name: 'Pagamento', exact: true }).selectOption(method);
    await expect(page.getByRole('textbox', { name: 'Desconto (R$)', exact: true })).toHaveValue('');
    await expect(page.getByTestId('cart-fee')).toContainText('0,00');
    const saved = await (await submit(page)).json();
    expect(saved.paymentMethod).toBe(method); expect(saved.items[0].discountCents).toBe(0); expect(saved.items[0].feeCents).toBe(0);
  }
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.products.find((p: any) => p.id === f.product.id).stock).toBe(8);
});

test('rascunho atravessa edição de participante e preço exigindo atualização explícita', async ({ page, request }) => {
  const f = await setup(page, request, 'Cadastro de teste');
  await editThroughUi(page, f.product.name, f.ownerB.name, '15,00');
  await expect(page.locator('.cart-item')).toContainText(f.ownerA.name);
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Atualizar itens do pedido', exact: true }).click();
  await expect(page.locator('.cart-item')).toContainText(f.ownerB.name);
  await editThroughUi(page, f.product.name, f.ownerB.name, '20,00');
  await expect(page.getByTestId('cart-total')).toContainText('15,00');
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Atualizar itens do pedido', exact: true }).click();
  await expect(page.getByTestId('cart-total')).toContainText('20,00');
  const saved = await (await submit(page)).json();
  expect(saved.items[0].ownerId).toBe(f.ownerB.id); expect(saved.items[0].priceCents).toBe(2000);
});

test('catálogo alterado depois da leitura é recusado pela API e permite correção após 409', async ({ page, request }) => {
  const f = await setup(page, request, 'Conflito de teste');
  expect((await request.put('/api/products/' + f.product.id, { data: { name: f.product.name, description: '', ownerId: f.ownerB.id,
    priceCents: 1500, stock: 10, active: true, expectedVersion: f.product.version } })).ok()).toBeTruthy();
  const response = page.waitForResponse(r => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('button', { name: 'Atualizar itens do pedido', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Pagamento', exact: true })).toBeEnabled();
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.sales.some((s: any) => s.items.some((i: any) => i.productId === f.product.id))).toBeFalsy();
  await page.getByRole('button', { name: 'Atualizar itens do pedido', exact: true }).click();
  expect((await (await submit(page)).json()).items[0].ownerId).toBe(f.ownerB.id);
});

test('resposta perdida congela corpo através de reload e edição de catálogo; retry não duplica', async ({ page, request }) => {
  const f = await setup(page, request, 'Reenvio de teste');
  let original: any;
  await page.route('**/api/sales', async route => {
    original = route.request().postDataJSON();
    const committed = await route.fetch(); expect(committed.ok()).toBeTruthy();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar');
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeDisabled();
  await page.unroute('**/api/sales');
  let retries = 0; page.on('request', r => { if (r.url().endsWith('/api/sales') && r.method() === 'POST') retries++; });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function() { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Nenhuma venda foi enviada'); expect(retries).toBe(0);
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).restoreStorage());
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Pagamento', exact: true })).toBeDisabled();
  await editThroughUi(page, f.product.name, f.ownerB.name, '20,00');
  await expect(page.locator('.cart-item')).toContainText(f.ownerA.name);
  await expect(page.getByRole('button', { name: 'Atualizar itens do pedido', exact: true })).toHaveCount(0);
  const retry = page.waitForRequest(r => r.url().endsWith('/api/sales') && r.method() === 'POST');
  const saved = await submit(page); expect((await retry).postDataJSON()).toEqual(original);
  expect((await saved.json()).items[0].ownerId).toBe(f.ownerA.id);
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.sales.filter((s: any) => s.id === original.requestId)).toHaveLength(1);
  expect(data.products.find((p: any) => p.id === f.product.id).stock).toBe(9);
});

test('rascunho v2 anterior recupera POST gravado sem acrescentar campos ao hash', async ({ page, request }) => {
  const f = await setup(page, request, 'Legado de teste');
  const original = { requestId: crypto.randomUUID(), fairId: f.fairId, date: f.date, paymentMethod: 'Dinheiro', status: 'Pago', note: '',
    items: [{ productId: f.product.id, quantity: 1, expectedPriceCents: 1500, discountCents: 0, feeCents: 0 }] };
  expect((await request.post('/api/sales', { data: original })).ok()).toBeTruthy();
  await page.evaluate(({ fairId, requestId, date, product }) => localStorage.setItem(`caixa-feira-draft-v2-${fairId}`, JSON.stringify({
    version: 2, fairId, requestId, date, items: [{ product, quantity: 1, discount: '', fee: '' }], method: 'Dinheiro', status: 'Pago', note: ''
  })), { fairId: f.fairId, requestId: original.requestId, date: f.date, product: f.product });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeDisabled();
  const retry = page.waitForRequest(r => r.url().endsWith('/api/sales') && r.method() === 'POST');
  await submit(page); expect((await retry).postDataJSON()).toEqual(original);
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.sales.filter((s: any) => s.id === original.requestId)).toHaveLength(1);
  expect(data.products.find((p: any) => p.id === f.product.id).stock).toBe(9);
});

test('falha ao guardar corpo bloqueia POST; falha no bootstrap após POST confirmado não congela carrinho', async ({ page, request }) => {
  const f = await setup(page, request, 'Persistência de teste');
  let posts = 0; page.on('request', r => { if (r.url().endsWith('/api/sales') && r.method() === 'POST') posts++; });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) {
      if (value.includes('pendingSubmission')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Nenhuma venda foi enviada'); expect(posts).toBe(0);
  await page.evaluate(() => (window as any).restoreStorage());
  await page.route('**/api/bootstrap?*', route => route.abort('failed'));
  await submit(page); expect(posts).toBe(1);
  await expect(page.getByRole('combobox', { name: 'Pagamento', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'aguarda confirmação' })).toHaveCount(0);
  expect(await page.evaluate(fairId => JSON.parse(localStorage.getItem(`caixa-feira-draft-v2-${fairId}`)!).pendingSubmission, f.fairId)).toBeUndefined();
  const data = await (await request.get('/api/bootstrap?date=' + f.date)).json();
  expect(data.products.find((p: any) => p.id === f.product.id).stock).toBe(9);
});

test('confirmação de envio incerto funciona depois de fechar dia, mudar data e encerrar feira', async ({ page, request }) => {
  const f = await setup(page, request, 'Fechamento e reenvio de teste');
  const loseResponse = async () => {
    let body: any;
    await page.route('**/api/sales', async route => {
      body = route.request().postDataJSON();
      expect((await route.fetch()).ok()).toBeTruthy();
      await route.abort('failed');
    });
    await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar');
    await page.unroute('**/api/sales');
    return body;
  };
  const first = await loseResponse();
  await page.getByRole('button', { name: 'Fechamento', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Fechar dia', exact: true }).click();
  await expect(page.locator('.status-line')).toHaveText('Fechado sem contagem');
  const tomorrow = new Date(f.date + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDate = tomorrow.toISOString().slice(0, 10);
  await page.locator('.date-field input').fill(nextDate);
  await page.getByRole('button', { name: 'Vender', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeEnabled();
  const firstRetry = page.waitForRequest(r => r.url().endsWith('/api/sales') && r.method() === 'POST');
  await submit(page); expect((await firstRetry).postDataJSON()).toEqual(first);
  await page.getByRole('button', { name: `Adicionar ${f.product.name}`, exact: true }).click();
  expect((await (await submit(page)).json()).date).toBe(nextDate);
  await page.getByRole('button', { name: `Adicionar ${f.product.name}`, exact: true }).click();
  const second = await loseResponse();
  await page.getByRole('button', { name: 'Feiras', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Encerrar feira', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Consulta da feira encerrada', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Vender', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeEnabled();
  const secondRetry = page.waitForRequest(r => r.url().endsWith('/api/sales') && r.method() === 'POST');
  await submit(page); expect((await secondRetry).postDataJSON()).toEqual(second);
  await expect(page.getByRole('button', { name: 'Registrar pedido', exact: true })).toBeDisabled();
  const data = await (await request.get('/api/bootstrap?date=' + nextDate)).json();
  expect(data.sales.filter((s: any) => s.id === first.requestId || s.id === second.requestId)).toHaveLength(2);
  expect(data.products.find((p: any) => p.id === f.product.id).stock).toBe(7);
});
