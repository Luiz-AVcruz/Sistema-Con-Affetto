import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('aproximação e inserido calculam taxas, recebem pendência sem taxa no Pix e usam só a Con Affetto na meta', async ({ page, request }) => {
  const owner = await (await request.post('/api/owners', { data: { name: 'Con Affetto' } })).json();
  const peer = await (await request.post('/api/owners', { data: { name: 'Participante pagamentos ' + randomUUID() } })).json();
  const products = [];
  for (const [ownerId, priceCents, name] of [[owner.id, 2000, 'Biscoito pagamentos'], [peer.id, 4000, 'Produto parceiro pagamentos']] as const) {
    const response = await request.post('/api/products', { data: { name, ownerId, priceCents, stock: 10, active: true, description: '' } });
    expect(response.ok()).toBeTruthy(); products.push(await response.json());
  }
  await page.goto('/');
  const date = await page.locator('.date-field input').inputValue();
  const before = await (await request.get('/api/bootstrap?date=' + date)).json();
  const baseline = before.fair.summary.byOwner.find((entry: any) => entry.ownerId === owner.id)?.netCents ?? 0;
  for (const product of products) await page.getByRole('button', { name: 'Adicionar ' + product.name, exact: true }).click();
  const payment = page.getByRole('combobox', { name: 'Pagamento', exact: true });
  for (const [choice, fee, net] of [
    ['Cartão débito','0,53','59,47'], ['Cartão débito inserido','1,19','58,81'],
    ['Cartão crédito','1,85','58,15'], ['Cartão crédito inserido','2,99','57,01'], ['Pix','0,00','60,00']
  ]) {
    await payment.selectOption(choice);
    await expect(page.getByTestId('cart-fee')).toContainText(fee);
    await expect(page.getByTestId('cart-net')).toContainText(net);
    await expect(page.getByTestId('cart-total')).toContainText('60,00');
  }
  await payment.selectOption('Cartão crédito');
  await page.reload();
  await expect(payment).toHaveValue('Cartão crédito');
  await expect(page.getByTestId('cart-fee')).toContainText('1,85');
  const response = page.waitForResponse(r => r.url().endsWith('/api/sales') && r.request().method() === 'POST');
  await page.getByRole('button',{name:'Registrar pedido',exact:true}).click();
  const savedResponse=await response; expect(savedResponse.ok()).toBeTruthy();
  // Após reload, o Brave pode descartar o corpo do POST na fronteira CDP.
  // Conferir o pedido persistido pelo UUID também prova o valor gravado no SQLite.
  const savedData=await(await request.get('/api/bootstrap?date='+date)).json();
  const saved=savedData.sales.find((sale:any)=>sale.id===savedResponse.request().postDataJSON().requestId);
  expect(saved).toBeDefined();
  expect(saved.cardEntry).toBe('Aproximação'); expect(saved.feeCents).toBe(185);
  expect(saved.items.map((item:any)=>[item.totalCents,item.feeCents,item.netCents])).toEqual([[2000,62,1938],[4000,123,3877]]);
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  await page.getByRole('button',{name:'Adicionar Biscoito pagamentos',exact:true}).click();
  await payment.selectOption('Cartão crédito inserido');
  await expect(page.getByTestId('cart-fee')).toContainText('1,00');
  await page.getByRole('combobox',{name:'Situação',exact:true}).selectOption('Pendente');
  await page.getByRole('button',{name:'Registrar pedido',exact:true}).click();
  await expect(page.getByTestId('cart-total')).toContainText('0,00');
  await page.getByRole('button',{name:'Histórico',exact:true}).click();
  const pending=page.locator('.history-order').filter({hasText:'Pendente'}).filter({hasText:'Biscoito pagamentos'});
  await expect(pending.getByRole('combobox',{name:'Forma de recebimento'})).toHaveValue('Cartão crédito inserido');
  await pending.getByRole('combobox',{name:'Forma de recebimento'}).selectOption('Pix');
  await pending.getByRole('button',{name:'Receber pendência',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Pagamento recebido'})).toBeVisible();
  const data=await(await request.get('/api/bootstrap?date='+date)).json();
  const paid=data.sales.find((sale:any)=>sale.id!==saved.id && sale.items.some((item:any)=>item.productId===products[0].id));
  expect(paid.feeCents).toBe(0); expect(paid.netCents).toBe(2000); expect(paid.cardEntry).toBeNull();
  await page.getByRole('button',{name:'Fechamento',exact:true}).click();
  const ownerRow=page.getByRole('row').filter({has:page.getByRole('cell',{name:'Con Affetto',exact:true})});
  await expect(ownerRow).toContainText('Con Affetto');
  await page.getByRole('button',{name:'Feiras',exact:true}).click();
  await page.getByRole('textbox',{name:'Meta da Con Affetto (R$)',exact:true}).fill('100,00');
  await page.getByRole('button',{name:'Salvar nome e meta',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Meta da feira salva'})).toBeVisible();
  const companyNet=baseline+3938;
  await expect(page.getByTestId('company-net')).toContainText((companyNet/100).toFixed(2).replace('.',','));
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow',String(Math.min(100,Math.floor(companyNet/100))));
  const csv=await(await request.get('/api/export/fairs.csv')).text();
  expect(csv).toContain('Bruto recebido de Con Affetto'); expect(csv).toContain('Taxas de Con Affetto');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('rascunho legado preserva taxa manual; novo carrinho e nova escolha de pagamento ativam taxas atuais', async ({page,request})=>{
  const owner=await(await request.post('/api/owners',{data:{name:'Rascunho pagamentos '+randomUUID()}})).json();
  const product=await(await request.post('/api/products',{data:{name:'Produto legado taxas',description:'',ownerId:owner.id,priceCents:2000,stock:null,active:true}})).json();
  await page.goto('/'); await expect(page.locator('.date-field input')).toBeEnabled();
  const date=await page.locator('.date-field input').inputValue();
  const data=await(await request.get('/api/bootstrap?date='+date)).json();
  for(const removeFirst of [true,false]) {
    await page.evaluate(({fairId,product,date,requestId})=>localStorage.setItem(`caixa-feira-draft-v2-${fairId}`,JSON.stringify({
      version:2,fairId,requestId,date,items:[{product,quantity:1,discount:'',fee:'0,37'}],method:'Cartão crédito',status:'Pago',note:'Legado'
    })),{fairId:data.fair.id,product,date,requestId:randomUUID()});
    await page.reload();
    await expect(page.getByText('Rascunho anterior: as taxas manuais foram preservadas.',{exact:true})).toBeVisible();
    await expect(page.getByTestId('cart-fee')).toContainText('0,37');
    if(removeFirst) {
      await page.getByRole('button',{name:'Remover',exact:true}).click();
      await page.getByRole('button',{name:'Adicionar Produto legado taxas',exact:true}).click();
    }
    await page.getByRole('combobox',{name:'Pagamento',exact:true}).selectOption('Cartão crédito inserido');
    await expect(page.getByTestId('cart-fee')).toContainText('1,00');
    await expect(page.getByTestId('cart-net')).toContainText('19,00');
    const response=page.waitForResponse(r=>r.url().endsWith('/api/sales')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Registrar pedido',exact:true}).click();
    const savedResponse=await response;expect(savedResponse.ok()).toBeTruthy();const saved=await savedResponse.json();
    expect(saved.cardEntry).toBe('Inserido');expect(saved.automaticFees).toBe(true);expect(saved.feeCents).toBe(100);
    await expect(page.getByTestId('cart-total')).toContainText('0,00');
  }
});
