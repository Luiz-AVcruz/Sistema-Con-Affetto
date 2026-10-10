import { test, expect } from '@playwright/test';

test('operador registra pedido misto, permuta, pendência, cancelamento e fecha sem contagem', async ({ page, request }) => {
  const ownerA = await (await request.post('/api/owners', { data: { name: 'Participante A' } })).json();
  const ownerB = await (await request.post('/api/owners', { data: { name: 'Participante B' } })).json();
  for (const product of [{ name: 'Pipoca', ownerId: ownerA.id, priceCents: 1500, stock: 10 }, { name: 'Caneca', ownerId: ownerB.id, priceCents: 4000, stock: 3 }]) {
    expect((await request.post('/api/products', { data: { ...product, description: '', active: true } })).ok()).toBeTruthy();
  }
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const submit = async () => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/sales') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
    expect((await response).ok()).toBeTruthy();
    await expect(page.getByTestId('cart-total')).toContainText('0,00');
    await expect(page.getByRole('combobox', { name: 'Pagamento', exact: true })).toHaveValue('Dinheiro');
  };
  await page.goto('/');
  await expect(page.locator('.app-header')).toHaveCSS('background-color', 'rgb(23, 43, 58)');
  await expect(page.getByRole('button', { name: 'Adicionar Pipoca', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar Pipoca', exact: true }).click();
  await page.getByRole('button', { name: 'Adicionar Caneca', exact: true }).click();
  await expect(page.getByTestId('cart-total')).toContainText('55,00');
  await page.reload();
  await expect(page.getByTestId('cart-total')).toContainText('55,00');
  await submit();
  await expect(page.getByRole('status').filter({ hasText: 'Pedido registrado' })).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar Pipoca', exact: true }).click();
  await page.getByRole('combobox', { name: 'Pagamento', exact: true }).selectOption('Permuta');
  await submit();
  await page.getByRole('button', { name: 'Adicionar Pipoca', exact: true }).click();
  await page.getByRole('combobox', { name: 'Situação', exact: true }).selectOption('Pendente');
  await submit();
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  const pending = page.locator('.history-order').filter({ hasText: 'Pendente' });
  await pending.getByRole('button', { name: 'Receber pendência', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Pagamento recebido' })).toBeVisible();
  const barter = page.locator('.history-order').filter({ hasText: 'Permuta' });
  page.once('dialog', dialog => dialog.accept());
  await barter.getByRole('button', { name: 'Cancelar pedido', exact: true }).click();
  await expect(barter).toContainText('Cancelado');
  await page.getByRole('button', { name: 'Fechamento', exact: true }).click();
  await expect(page.getByTestId('day-net')).toContainText('70,00');
  await expect(page.getByTestId('fair-net')).toContainText('70,00');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Fechar dia', exact: true }).click();
  await expect(page.locator('.status-line')).toHaveText('Fechado sem contagem');
  await page.getByRole('button', { name: 'Vender', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adicionar Pipoca', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Adicionar Pipoca', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
