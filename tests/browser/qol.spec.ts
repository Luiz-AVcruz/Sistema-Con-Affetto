import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function catalog(request: APIRequestContext) {
  const suffix = randomUUID();
  const owner = await (await request.post('/api/owners', { data: { name: `Márcia ${suffix}` } })).json();
  const products = [];
  for (const [name, stock, active] of [
    ['Pão açucarado', 8, true], ['Biscoito esgotado', 0, true],
    ['Doce inativo', 3, false], ['Farinha a contar', null, true]
  ] as const) {
    const response = await request.post('/api/products', { data: {
      name: `${name} ${suffix}`, description: 'Porção de 50 g', ownerId: owner.id,
      priceCents: 1234, stock, active
    } });
    expect(response.ok(), await response.text()).toBeTruthy();
    products.push(await response.json());
  }
  return { owner, products };
}

async function open(page: Page, request: APIRequestContext) {
  await page.goto('/');
  await expect(page.locator('.date-field input')).toBeEnabled();
  const date = await page.locator('.date-field input').inputValue();
  const data = await (await request.get('/api/bootstrap?date=' + date)).json();
  expect(data.day.closedAt).toBeNull();
  return { date, data };
}

test('buscas toleram acentos e espaços; filtros distinguem estoque zero, desconhecido e produto inativo sem alterar o rascunho', async ({ page, request }, testInfo) => {
  const { products, owner } = await catalog(request);
  const { data, date } = await open(page, request);
  const search = page.getByRole('searchbox', { name: 'Buscar produto ou participante' });
  await search.fill('  MARCIA   pao  ');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Adicionar ' + products[0].name, exact: true }).click();
  const key = `caixa-feira-draft-v2-${data.fair.id}`;
  const draft = await page.evaluate(key => localStorage.getItem(key), key);
  await search.fill('nome que não existe');
  await expect(page.getByText('Nenhum produto corresponde à busca.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('cart-total')).toContainText('12,34');
  await page.getByRole('button', { name: 'Limpar busca', exact: true }).click();
  await search.fill(owner.name);
  await expect(page.getByRole('button', { name: 'Adicionar ' + products[1].name, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Adicionar ' + products[3].name, exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Adicionar ' + products[2].name, exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);

  await page.getByRole('button', { name: 'Produtos', exact: true }).click();
  const productSearch = page.getByRole('searchbox', { name: 'Buscar no cadastro' });
  await productSearch.fill('marcia pao');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await rows.getByRole('button', { name: 'Editar', exact: true }).click();
  await productSearch.fill(owner.name);
  await page.getByRole('combobox', { name: 'Mostrar produtos' }).selectOption('out-of-stock');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(products[1].name);
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue(products[0].name);
  await page.getByRole('combobox', { name: 'Mostrar produtos' }).selectOption('inactive');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(products[2].name);
  await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue(products[0].name);
  await page.getByRole('button', { name: 'Vender', exact: true }).click();
  await expect(page.getByTestId('cart-total')).toContainText('12,34');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);
  expect(await (await request.get('/api/bootstrap?date=' + date)).json()).toEqual(data);
  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill('pao marcia');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('busca-celular.png'), fullPage: true });
});

test('manter o pedido conserva UUID e conteúdo; confirmar limpa sem apagar vendas; registrar não pede confirmação de limpeza', async ({ page, request }) => {
  const { products } = await catalog(request);
  const { data, date } = await open(page, request);
  await page.getByRole('button', { name: 'Adicionar ' + products[0].name, exact: true }).click();
  await page.getByRole('textbox', { name: 'Observação', exact: true }).fill('Pedido para Ágatha');
  const key = `caixa-feira-draft-v2-${data.fair.id}`;
  const draft = await page.evaluate(key => localStorage.getItem(key), key);
  const confirmation = page.getByRole('region', { name: 'Descartar este rascunho?' });
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manter pedido', exact: true })).toBeFocused();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);
  await page.getByRole('button', { name: 'Manter pedido', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeFocused();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
  await page.getByRole('button', { name: 'Descartar rascunho', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  await expect(page.getByRole('textbox', { name: 'Observação', exact: true })).toHaveValue('');
  expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), key))!).requestId).not.toBe(JSON.parse(draft!).requestId);
  expect(await (await request.get('/api/bootstrap?date=' + date)).json()).toEqual(data);

  await page.getByRole('combobox', { name: 'Pagamento', exact: true }).selectOption('Pix');
  const paymentDraft = await page.evaluate(key => localStorage.getItem(key), key);
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await page.getByRole('button', { name: 'Manter pedido', exact: true }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(paymentDraft);
  await page.getByRole('combobox', { name: 'Pagamento', exact: true }).selectOption('Dinheiro');

  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await page.getByRole('button', { name: 'Adicionar ' + products[0].name, exact: true }).click();
  const submitted = JSON.parse((await page.evaluate(key => localStorage.getItem(key), key))!);
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  await expect(confirmation).toHaveCount(0);
  expect(dialogs).toEqual([]);
  const result = await (await request.get('/api/bootstrap?date=' + date)).json();
  expect(result.sales.filter((sale: { id: string }) => sale.id === submitted.requestId)).toHaveLength(1);
  expect((await request.delete(`/api/sales/${submitted.requestId}?fairId=${data.fair.id}`, { data: {} })).ok()).toBeTruthy();
});

test('editar o pedido e trocar de feira desarmam uma confirmação anterior sem descartar o rascunho', async ({ page, request }) => {
  const { products } = await catalog(request);
  const { data } = await open(page, request);
  const add = page.getByRole('button', { name: 'Adicionar ' + products[0].name, exact: true });
  const clear = page.getByRole('button', { name: 'Limpar', exact: true });
  const confirmation = page.getByRole('region', { name: 'Descartar este rascunho?' });
  const key = `caixa-feira-draft-v2-${data.fair.id}`;
  await add.click();
  await clear.click();
  await expect(confirmation).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar produto ou participante' }).fill('pao');
  await expect(confirmation).toBeVisible();
  await add.click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Quantidade', exact: true })).toHaveValue('2');
  const draft = await page.evaluate(key => localStorage.getItem(key), key);
  await clear.click();
  await expect(confirmation).toBeVisible();
  const other = data.fairs.find((fair: { id: number }) => fair.id !== data.fair.id);
  await page.locator('.fair-field select').selectOption({ label: `${other.name} · ${other.closedAt ? 'Encerrada' : 'Ativa'}` });
  await expect(confirmation).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);
  await page.locator('.fair-field select').selectOption({ label: `${data.fair.name} · Ativa` });
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Quantidade', exact: true })).toHaveValue('2');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(draft);
});

test('busca e limpeza não alteram um envio sem resposta; repetir confirma o mesmo pedido uma única vez', async ({ page, request }) => {
  const { products } = await catalog(request);
  const { data, date } = await open(page, request);
  await page.getByRole('button', { name: 'Adicionar ' + products[0].name, exact: true }).click();
  let body: unknown;
  await page.route('**/api/sales', async route => {
    body = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Descartar este rascunho?' })).toBeVisible();
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await expect(page.getByText('Este pedido aguarda confirmação.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Descartar este rascunho?' })).toHaveCount(0);
  const key = `caixa-feira-draft-v2-${data.fair.id}`;
  const frozen = await page.evaluate(key => localStorage.getItem(key), key);
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Buscar produto ou participante' }).fill('qualquer busca');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(frozen);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Limpar', exact: true })).toBeDisabled();
  await page.unroute('**/api/sales');
  const retried = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/sales'));
  await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  expect((await retried).postDataJSON()).toEqual(body);
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  const id = (body as { requestId: string }).requestId;
  const result = await (await request.get('/api/bootstrap?date=' + date)).json();
  expect(result.sales.filter((sale: { id: string }) => sale.id === id)).toHaveLength(1);
  expect(result.products.find((product: { id: number }) => product.id === products[0].id).stock).toBe(7);
  expect((await request.delete(`/api/sales/${id}?fairId=${data.fair.id}`, { data: {} })).ok()).toBeTruthy();
});

test('histórico combina busca, situação e período sem limitar o CSV ou mudar o dia; lembra a situação e tolera armazenamento indisponível', async ({ page, request }, testInfo) => {
  const { products } = await catalog(request);
  const { data, date } = await open(page, request);
  const tomorrow = new Date(date + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDate = tomorrow.toISOString().slice(0, 10);
  const prefix = randomUUID();
  const ids: string[] = [];
  for (const [status, saleDate, suffix] of [['Pago', date, 'Pago'], ['Pendente', date, 'Pendente'], ['Pendente', nextDate, 'Futuro'], ['Pendente', date, 'Cancelado']] as const) {
    const id = randomUUID(); ids.push(id);
    expect((await request.post('/api/sales', { data: { requestId: id, fairId: data.fair.id, date: saleDate,
      paymentMethod: 'Pix', status, note: `Entrega Ágatha ${prefix} ${suffix}`,
      items: [{ productId: products[0].id, quantity: 1, expectedPriceCents: 1234, discountCents: 0, feeCents: 0 }]
    } })).ok()).toBeTruthy();
    if (suffix === 'Cancelado') expect((await request.post(`/api/sales/${id}/cancel?fairId=${data.fair.id}`, { data: {} })).ok()).toBeTruthy();
  }
  await page.reload();
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Buscar no histórico' });
  const status = page.getByRole('combobox', { name: 'Situação dos pedidos' });
  await search.fill('  agatha   ' + prefix);
  await expect(page.locator('.history-order')).toHaveCount(3);
  await status.selectOption('Pendente');
  await expect(page.locator('.history-order')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'Mostrar todos os dias' }).check();
  await expect(page.locator('.history-order')).toHaveCount(2);
  await expect(page.locator('.date-field input')).toHaveValue(date);
  const before = await (await request.get('/api/bootstrap?date=' + date)).json();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exportar CSV desta feira', exact: true }).click();
  const exported = await download; expect(exported.suggestedFilename()).toBe('vendas-feira.csv');
  const csv = await readFile((await exported.path())!, 'utf8');
  for (const id of ids) expect(csv).toContain(id);
  expect(await (await request.get('/api/bootstrap?date=' + date)).json()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('historico-filtrado.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(status).toHaveValue('Pendente');
  await expect(search).toHaveValue('');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'caixa-feira-history-preferences-v1') throw new DOMException('Sem espaço', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Limpar busca e situação', exact: true }).click();
  await expect(status).toHaveValue('all');
  for (const id of ids) expect((await request.delete(`/api/sales/${id}?fairId=${data.fair.id}`, { data: {} })).ok()).toBeTruthy();
});

test('restaurar comparação padrão reinicia todas as escolhas apenas da feira consultada e conserva banco e dia de trabalho', async ({ page, request }) => {
  const { data, date } = await open(page, request);
  const fair = data.fairs.find((fair: { id: number }) => fair.id === 1);
  await page.locator('.fair-field select').selectOption({ label: `${fair.name} · ${fair.closedAt ? 'Encerrada' : 'Ativa'}` });
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restaurar comparação padrão', exact: true })).toBeVisible();
  const key = 'caixa-feira-comparisons-v1-999999';
  await page.evaluate(key => localStorage.setItem(key, 'outra feira'), key);
  const before = await (await request.get('/api/bootstrap?date=' + date + '&fairId=1')).json();
  await page.getByRole('combobox', { name: 'Comparar', exact: true }).selectOption('owners');
  await page.getByRole('combobox', { name: 'Agrupar comparação' }).selectOption('week');
  await page.getByRole('combobox', { name: 'Valores por período' }).selectOption('fees');
  await page.getByRole('combobox', { name: 'Ordenar comparação' }).selectOption('net-asc');
  await page.getByRole('checkbox', { name: 'Mostrar fechamentos vazios' }).check();
  await page.getByRole('button', { name: 'Limpar dias da comparação', exact: true }).click();
  await page.getByText('Escolher produtos e participantes', { exact: true }).click();
  await page.getByRole('button', { name: 'Limpar participantes', exact: true }).click();
  await page.getByRole('button', { name: 'Limpar produtos', exact: true }).click();
  await page.getByRole('button', { name: 'Restaurar comparação padrão', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Comparar', exact: true })).toHaveValue('both');
  await expect(page.getByRole('combobox', { name: 'Agrupar comparação' })).toHaveValue('day');
  await expect(page.getByRole('combobox', { name: 'Valores por período' })).toHaveValue('units-net');
  await expect(page.getByRole('combobox', { name: 'Ordenar comparação' })).toHaveValue('units-desc');
  await expect(page.getByRole('checkbox', { name: 'Mostrar fechamentos vazios' })).not.toBeChecked();
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.comparison-day input')].every(input => input.checked))).toBeTruthy();
  const defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('caixa-feira-comparisons-v1-1')!));
  expect(defaults.dates).toBeNull(); expect(defaults.ownerIds).toBeNull(); expect(defaults.productKeys).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('outra feira');
  await expect(page.locator('.date-field input')).toHaveValue(date);
  expect(await (await request.get('/api/bootstrap?date=' + date + '&fairId=1')).json()).toEqual(before);
  await page.reload();
  await page.locator('.fair-field select').selectOption({ label: `${fair.name} · ${fair.closedAt ? 'Encerrada' : 'Ativa'}` });
  await page.getByRole('button', { name: 'Sumário', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Agrupar comparação' })).toHaveValue('day');
});
