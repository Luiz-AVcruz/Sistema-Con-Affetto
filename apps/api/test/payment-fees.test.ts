import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from '../src/paths.js';
import { legacyPaymentColumns } from './legacy-database.js';
import { importHistory } from '../src/historical-import.js';
import { calculatePaymentFees, type CardEntry, type PaymentMethod, type SaleInput } from '@caixa/shared';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { saleSchema } from '../src/validation.js';

const cash = { openingCents: 2000, extraCents: 0, withdrawalCents: 0, countedCents: null, note: 'Original' };
function fixture() {
  const db = openDatabase(':memory:'), register = new CashRegister(db);
  for (const [id, name] of [[1, 'Con Affetto'], [2, 'Outra participante']] as const) db.prepare('INSERT INTO owners(id,name) VALUES(?,?)').run(id, name);
  const products = [1, 2].map(ownerId => register.saveProduct({ name: 'Produto ' + ownerId, description: '', ownerId, priceCents: 2000, stock: 10, active: true }));
  const input = (method: PaymentMethod = 'Cartão crédito', entry: CardEntry = 'Aproximação'): SaleInput => ({
    requestId: randomUUID(), date: '2026-10-10', paymentMethod: method, status: 'Pago', note: '', automaticFees: true,
    ...(method.startsWith('Cartão') ? { cardEntry: entry } : {}),
    items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: 2000, discountCents: 0, feeCents: 0 }))
  });
  return { db, register, products, input };
}

test('taxas confirmadas, arredondamento do pedido e distribuição conservam centavos', () => {
  for (const [method, entry, fee] of [
    ['Cartão débito', 'Aproximação', 18], ['Cartão crédito', 'Aproximação', 62],
    ['Cartão débito', 'Inserido', 40], ['Cartão crédito', 'Inserido', 100],
    ['Dinheiro', null, 0], ['Pix', null, 0], ['Permuta', null, 0], ['Não cobrado', null, 0]
  ] as const) assert.deepEqual(calculatePaymentFees([2000], method, entry), [fee]);
  assert.deepEqual(calculatePaymentFees([2000, 2000], 'Cartão crédito'), [62, 62]);
  // Arredondar cada item isoladamente daria 124; a transação de R$ 39,96 custa 123.
  const fractional = calculatePaymentFees([999, 999, 999, 999], 'Cartão crédito');
  assert.deepEqual(fractional, [31,31,31,30]);
  assert.deepEqual(calculatePaymentFees([1, 1, 15], 'Cartão crédito'), [0, 0, 1]);
  assert.deepEqual(calculatePaymentFees([0, 1000], 'Cartão crédito'), [0, 31]);
  assert.deepEqual(calculatePaymentFees([1_000_000_000_000], 'Cartão crédito', 'Inserido'), [49_800_000_000]);
  for (const amounts of [[-1], [0.5], [NaN], [Infinity]]) assert.throws(() => calculatePaymentFees(amounts, 'Cartão crédito'));
});

test('API calcula taxa sobre o cobrado, preserva preço/desconto e separa bruto, taxa e líquido por participante', () => {
  const { db, register, input } = fixture();
  try {
    const order = input(); order.items[0].discountCents = 100;
    const saved = register.createSale(saleSchema.parse(order));
    assert.equal(saved.totalCents, 3900); assert.equal(saved.feeCents, 121); assert.equal(saved.netCents, 3779);
    assert.deepEqual(saved.items.map(item => [item.totalCents,item.feeCents,item.netCents]), [[1900,59,1841],[2000,62,1938]]);
    assert.equal(saved.cardEntry, 'Aproximação'); assert.equal(saved.automaticFees, true);
    const summary = register.summary();
    assert.deepEqual(summary.byOwner.map(owner => [owner.receivedCents,owner.feeCents,owner.netCents]), [[1900,59,1841],[2000,62,1938]]);
    assert.equal(summary.byOwner.reduce((sum, owner) => sum+owner.netCents,0),summary.netCents);
    assert.deepEqual(register.createSale(saleSchema.parse(order)),saved);
    assert.throws(() => register.createSale(saleSchema.parse({...order,cardEntry:'Inserido'})), /outros valores/);
    const manipulated = input(); manipulated.items[0].feeCents=1;
    assert.throws(() => register.createSale(manipulated), /zero nas taxas manuais/);
    assert.throws(() => register.createSale({...input('Pix'),cardEntry:'Inserido'}), /leitura do cartão/);
    assert.equal(register.sales().length,1);
  } finally { db.close(); }
});

test('recebimento recalcula com preço histórico e pagamento real; repetições não baixam estoque nem taxas novamente', () => {
  const { db, register, products, input } = fixture();
  try {
    const pending = register.createSale({...input('Cartão crédito','Inserido'),status:'Pendente'});
    register.closeDay('2026-10-10',cash);
    const product = register.products()[0]; register.saveProduct({...product,priceCents:9999,expectedVersion:product.version},product.id);
    const received = register.receiveSale(pending.id,'2026-10-11','Cartão débito',{automaticFees:true,cardEntry:'Aproximação'});
    assert.equal(received.totalCents,4000); assert.equal(received.feeCents,36); assert.equal(received.netCents,3964);
    assert.equal(register.day('2026-10-10').summary.receivedCents,0);
    assert.equal(register.day('2026-10-11').summary.netCents,3964);
    assert.deepEqual(register.receiveSale(pending.id,'2026-10-11','Cartão débito',{automaticFees:true,cardEntry:'Aproximação'}),received);
    assert.throws(()=>register.receiveSale(pending.id,'2026-10-11','Cartão débito',{automaticFees:true,cardEntry:'Inserido'}),/já recebido/);
    assert.deepEqual(register.products().map(product=>product.stock),[9,9]);
    const next=register.createSale({...input('Cartão crédito','Inserido'),requestId:randomUUID(),date:'2026-10-11',status:'Pendente',
      items:[{productId:products[1].id,quantity:1,expectedPriceCents:2000,discountCents:0,feeCents:0}]});
    assert.equal(register.receiveSale(next.id,'2026-10-11','Pix',{automaticFees:true}).feeCents,0);
  } finally { db.close(); }
});

test('retificação preserva todos os registros originais, hashes, estoque e snapshots e não é aplicada duas vezes', () => {
  const { db, register, input } = fixture();
  try {
    const {automaticFees,cardEntry,...legacy}=input();
    const saved=register.createSale(legacy);
    const closed=register.closeDay('2026-10-10',cash);
    // Simula o snapshot anterior à adição dos novos campos por participante.
    const historical = {...closed,summary:{...closed.summary,byOwner:closed.summary.byOwner.map(({receivedCents,feeCents,...owner})=>owner)}};
    db.prepare('UPDATE days SET snapshot=?').run(JSON.stringify(historical));
    const tables=['sales','sale_items','days','products','spreadsheet_records'];
    const rows=()=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before=rows();
    const result=register.correctPastCardFees('Taxas confirmadas');
    assert.deepEqual(result,{saleCount:1,feeCents:124,byOwner:[{name:'Con Affetto',feeCents:62},{name:'Outra participante',feeCents:62}]});
    assert.deepEqual(rows(),before);
    const adjusted=register.day('2026-10-10');
    assert.equal(adjusted.summary.netCents,4000); assert.equal(adjusted.adjustedSummary!.netCents,3876);
    assert.equal(adjusted.feeCorrectionCents,124); assert.equal(adjusted.expectedCents,closed.expectedCents);
    assert.deepEqual(adjusted.adjustedSummary!.byOwner.map(owner=>[owner.receivedCents,owner.feeCents,owner.netCents]),[[2000,62,1938],[2000,62,1938]]);
    const retried=register.createSale(legacy);
    assert.equal(retried.id,saved.id); assert.equal(retried.feeCents,124); assert.equal(retried.feeCorrected,true);
    assert.equal(register.summary().netCents,3876);
    assert.equal(register.bootstrap('2026-10-10').closedDays[0].adjustedSummary!.netCents,3876);
    assert.equal(register.correctPastCardFees('Repetição').saleCount,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_fee_corrections').get()!.n,2);
    assert.deepEqual(rows(),before);
    assert.throws(()=>register.cancelSale(saved.id),/fechado/); assert.throws(()=>register.deleteSale(saved.id),/fechado/);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok'); assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally { db.close(); }
});

test('fechar depois de retificar não desconta novamente e cancelamento/exclusão corrigem só o pedido selecionado', () => {
  const { db, register, input } = fixture();
  try {
    const {automaticFees,cardEntry,...legacy}=input();
    const past=register.createSale(legacy); register.correctPastCardFees('Confirmado');
    const closed=register.closeDay('2026-10-10',cash);
    assert.equal(closed.summary.netCents,3876); assert.equal(register.day('2026-10-10').adjustedSummary,undefined);
    const active=register.createSale({...input('Cartão crédito','Inserido'),date:'2026-10-11'});
    assert.equal(active.feeCents,199);
    register.deleteSale(active.id);
    assert.equal(register.summary().netCents,3876); assert.deepEqual(register.products().map(product=>product.stock),[9,9]);
    assert.equal(register.sales()[0].id,past.id);
    const archived=register.closeFair('2026-10-11');
    assert.equal(archived.summary.netCents,3876); assert.deepEqual(register.fair(),archived);
    assert.throws(()=>register.correctPastCardFees('Outra tentativa'),/encerrada/);
  } finally { db.close(); }
});

test('falha no segundo estoque desfaz recebimento, forma, taxas e a primeira baixa', () => {
  const { db, register, input, products } = fixture();
  try {
    const pending=register.createSale({...input('Cartão crédito','Inserido'),status:'Pendente'});
    const product=register.products().find(product=>product.id===products[1].id)!;
    register.saveProduct({...product,stock:0,expectedVersion:product.version},product.id);
    const before=register.bootstrap('2026-10-10');
    assert.throws(()=>register.receiveSale(pending.id,'2026-10-10','Pix',{automaticFees:true}),/Estoque insuficiente/);
    assert.deepEqual(register.bootstrap('2026-10-10'),before);
  } finally { db.close(); }
});

test('CLI simula sem mudar banco v5, cria backup antes de corrigir e restaura a trilha completa', () => {
  const folder=mkdtempSync(join(tmpdir(),'caixa-cli-taxas-')), path=join(folder,'caixa.sqlite');
  let db=openDatabase(path);
  try {
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Con Affetto');
    const register=new CashRegister(db);
    const product=register.saveProduct({name:'Produto CLI',description:'',ownerId:1,priceCents:2000,stock:5,active:true});
    register.createSale({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Cartão crédito',status:'Pago',note:'',
      items:[{productId:product.id,quantity:1,expectedPriceCents:2000,discountCents:0,feeCents:0}]});
    register.closeDay('2026-10-10',cash);
    legacyPaymentColumns(db); db.close();
    const before=readFileSync(path);
    const run=(...args:string[])=>spawnSync(process.execPath,args,{cwd:projectRoot,encoding:'utf8'});
    const dry=run('scripts/corrigir-taxas-cartao.mjs',path,'1');
    assert.equal(dry.status,0,dry.stderr); assert.equal(JSON.parse(dry.stdout).feeCents,62);
    assert.deepEqual(readFileSync(path),before);
    const applied=run('scripts/corrigir-taxas-cartao.mjs',path,'1','--apply');
    assert.equal(applied.status,0,applied.stderr);
    const report=JSON.parse(applied.stdout);
    assert.equal(report.saleCount,1); assert.equal(report.summary.netCents,1938);
    const backup=readFileSync(report.backup); assert.deepEqual(backup,before);
    db=openDatabase(path);
    assert.equal(new CashRegister(db).day('2026-10-10').summary.netCents,2000);
    assert.equal(new CashRegister(db).day('2026-10-10').adjustedSummary!.netCents,1938);
    const full=join(folder,'full.sqlite');
    const tables=['sales','sale_items','days','products','payment_fee_corrections'];
    const expected=tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    writeFileSync(full,db.serialize()); db.close();
    const target=join(folder,'restaurado.sqlite');
    const restored=run('scripts/restaurar-backup.mjs',full,target);
    assert.equal(restored.status,0,restored.stderr);
    db=openDatabase(target);
    assert.deepEqual(tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),expected);
    const restoredRegister=new CashRegister(db);
    assert.equal(restoredRegister.day('2026-10-10').summary.netCents,2000);
    assert.equal(restoredRegister.day('2026-10-10').adjustedSummary!.netCents,1938);
    assert.equal(restoredRegister.summary().netCents,1938);
    assert.equal(restoredRegister.correctPastCardFees('Repetição').saleCount,0);
  } finally { if(db.open) db.close(); rmSync(folder,{recursive:true,force:true}); }
});

test('fechamento importado após retificação inclui o marcador e não desconta a taxa novamente', () => {
  const db=openDatabase(':memory:'), register=new CashRegister(db);
  try {
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Con Affetto');
    const product=register.saveProduct({name:'Produto',description:'',ownerId:1,priceCents:2000,stock:null,active:true});
    register.createSale({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Cartão crédito',status:'Pago',note:'',
      items:[{productId:product.id,quantity:1,expectedPriceCents:2000,discountCents:0,feeCents:0}]});
    register.correctPastCardFees('Confirmado');
    const expected={receivedCents:2000,netCents:2000,discountCents:0,feeCents:0,pendingCents:0,barterUnits:0,giftUnits:0,
      byOwner:{'Con Affetto':2000},byPayment:{'Dinheiro':2000,'Pix':0,'Cartão débito':0,'Cartão crédito':0}};
    importHistory(db,{formatVersion:1,sourceKey:'caixa-da-feira-ods',source:'fixture.ods',sha256:'a'.repeat(64),lockPresent:false,
      products:[{name:'Produto',stock:null}],rows:[{rowNumber:6,orderRef:'',date:'2026-10-10',paymentMethod:'Dinheiro',status:'Pago',note:'',
        name:'Produto',ownerName:'Con Affetto',quantity:1,priceCents:2000,discountCents:0,feeCents:0,totalCents:2000,netCents:2000}],expected,
      closedDays:[{date:'2026-10-10',cash:{...cash,openingCents:0},expectedCents:2000,differenceCents:null,
        expected:{...expected,receivedCents:4000,netCents:3938,feeCents:62,byOwner:{'Con Affetto':3938},
          byPayment:{'Dinheiro':2000,'Pix':0,'Cartão débito':0,'Cartão crédito':2000}}}]});
    const day=register.day('2026-10-10');
    assert.equal(day.summary.netCents,3938); assert.equal(day.adjustedSummary,undefined);
    assert.equal(day.feeCorrectionsThroughId,register.latestFeeCorrectionId());
    assert.equal(register.summary().netCents,3938); assert.equal(register.bootstrap('2026-10-10').closedDays[0].adjustedSummary,undefined);
  } finally { db.close(); }
});
