import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { calculateSplitPaymentFees, type SaleInput, type SalePaymentInput } from '@caixa/shared';
import { CashRegister } from '../src/cash-register.js';
import { openDatabase, schemaVersion } from '../src/database.js';
import { saleSchema } from '../src/validation.js';
import { createApp } from '../src/app.js';

const cash = { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' };
const payments: SalePaymentInput[] = [{ paymentMethod: 'Dinheiro', amountCents: 5000 },
  { paymentMethod: 'Cartão crédito', amountCents: 3200, cardEntry: 'Aproximação' }];

function fixture(path = ':memory:') {
  const db = openDatabase(path), register = new CashRegister(db);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?), (2,?)').run('Con Affetto', 'Outra participante');
  const products = [[2,'Caneca de teste',5000],[1,'Biscoito de teste',2000],[1,'Baunilha de teste',1200]].map(([ownerId,name,priceCents]) =>
    register.saveProduct({ ownerId: ownerId as number, name: name as string, priceCents: priceCents as number, description: '', stock: 5, active: true }));
  const input = (): SaleInput => ({ requestId: randomUUID(), date: '2026-10-11', paymentMethod: 'Dinheiro', status: 'Pago', note: '', automaticFees: true,
    items: products.map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })),
    payments: payments.map(payment => ({ ...payment })) });
  return { db, register, products, input };
}

function records(db: Database.Database) {
  return ['sales','sale_items','sale_payments','products','fairs','days','payment_fee_corrections'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('rateio proporcional conserva centavos entre participantes antes de distribuí-los aos itens', () => {
  const result = calculateSplitPaymentFees([5000,2000,1200],[2,1,1],payments);
  assert.deepEqual(result.fees,[60,24,15]);
  assert.deepEqual(result.payments.map(payment => [payment.amountCents,payment.feeCents,payment.netCents]),[[5000,0,5000],[3200,99,3101]]);
  assert.deepEqual(calculateSplitPaymentFees([5000,3200],[2,1],payments).fees,[60,39]);
  // O mesmo total de um participante, fragmentado em mais produtos, não pode
  // transferir para ele os centavos que pertencem à quota de outro participante.
  const fragmented = calculateSplitPaymentFees([5000,...Array(32).fill(100)],[2,...Array(32).fill(1)],payments).fees;
  assert.equal(fragmented[0],60); assert.equal(fragmented.slice(1).reduce((sum,fee) => sum+fee,0),39);
  assert.deepEqual(calculateSplitPaymentFees([0,5000,3200],[3,2,1],payments).fees,[0,60,39]);
  // Em empate, o primeiro participante do pedido recebe o centavo indivisível.
  assert.deepEqual(calculateSplitPaymentFees([17,17],[2,1],[{paymentMethod:'Dinheiro',amountCents:17},{paymentMethod:'Cartão crédito',amountCents:17}]).fees,[1,0]);
  // Arredondar uma vez por transação de cartão é diferente de arredondar o
  // montante combinado. Débito 17c + crédito 17c: 0c + 1c de taxa.
  const cards = calculateSplitPaymentFees([34],[1],[{paymentMethod:'Cartão débito',amountCents:17},{paymentMethod:'Cartão crédito',amountCents:17}]);
  assert.deepEqual(cards.payments.map(payment => payment.feeCents),[0,1]); assert.deepEqual(cards.fees,[1]);
  assert.deepEqual(calculateSplitPaymentFees([8200],[1],[{paymentMethod:'Cartão crédito',amountCents:5000},{paymentMethod:'Cartão crédito',amountCents:3200,cardEntry:'Inserido'}]).payments.map(payment => payment.feeCents),[155,159]);
  for (let i=1;i<=120;i++) {
    const amounts=[i*23,i*7,i*19,i*3,0], ids=[1,2,1,3,2], total=amounts.reduce((a,b)=>a+b,0);
    const calculated=calculateSplitPaymentFees(amounts,ids,[{paymentMethod:'Pix',amountCents:i},{paymentMethod:'Cartão crédito',amountCents:total-i}]);
    const fee=calculated.payments.reduce((sum,payment)=>sum+payment.feeCents,0);
    assert.equal(calculated.fees.reduce((sum,value)=>sum+value,0),fee);
    for (const owner of [1,2,3]) {
      const amount=amounts.reduce((sum,value,index)=>sum+(ids[index]===owner?value:0),0);
      const allocated=calculated.fees.reduce((sum,value,index)=>sum+(ids[index]===owner?value:0),0);
      // Prova independente de quota: erro menor que um centavo em cada dono.
      assert.ok(Math.abs(allocated*total-fee*amount)<total);
    }
    calculated.fees.forEach((value,index)=>assert.ok(value>=0 && value<=amounts[index]));
  }
  const large=calculateSplitPaymentFees([Number.MAX_SAFE_INTEGER],[1],[{paymentMethod:'Dinheiro',amountCents:1},{paymentMethod:'Cartão crédito',amountCents:Number.MAX_SAFE_INTEGER-1}]);
  assert.equal(large.fees[0],large.payments[1].feeCents);
  assert.throws(()=>calculateSplitPaymentFees([Number.MAX_SAFE_INTEGER,1],[1,2],[{paymentMethod:'Dinheiro',amountCents:Number.MAX_SAFE_INTEGER},{paymentMethod:'Pix',amountCents:1}]),/soma/);
});

test('pedido de R$82 com dois pagamentos é uma venda e uma baixa de estoque, com R$0,99 de taxa', () => {
  const { db,register,input }=fixture();
  try {
    const saved=register.createSale(saleSchema.parse(input())), summary=register.summary('2026-10-11');
    assert.equal(saved.totalCents,8200); assert.equal(saved.feeCents,99); assert.equal(saved.netCents,8101);
    assert.deepEqual(saved.items.map(item=>item.feeCents),[60,24,15]);
    assert.equal(saved.payments!.length,2); assert.equal(saved.payments![0].cardEntry,null);
    assert.equal(summary.paidCount,1); assert.equal(summary.receivedCents,8200); assert.equal(summary.netCents,8101);
    assert.deepEqual(summary.byPayment.map(payment=>payment.totalCents),[5000,0,0,3200]);
    assert.deepEqual(summary.byOwner.map(owner=>[owner.receivedCents,owner.feeCents,owner.netCents]),[[3200,39,3161],[5000,60,4940]]);
    assert.equal(register.day('2026-10-11').expectedCents,5000);
    assert.deepEqual(register.products().map(product=>product.stock),[4,4,4]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales').get()!.n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_payments').get()!.n,2);
    assert.equal(register.correctPastCardFees('Não retificar venda automática').saleCount,0);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  } finally { db.close(); }
});

test('descontos mudam a base de rateio; pagamentos inválidos não deixam pedido, taxas ou estoque parcial', () => {
  const {db,register,input}=fixture();
  try {
    const discounted=input(); discounted.items[0].discountCents=1000; discounted.payments![0].amountCents=4000;
    const saved=register.createSale(saleSchema.parse(discounted));
    assert.equal(saved.totalCents,7200); assert.equal(saved.discountCents,1000); assert.equal(saved.feeCents,99);
    assert.deepEqual(saved.items.map(item=>item.feeCents),[55,28,16]);
    const invalid: SaleInput[]=[];
    const wrongTotal=input(); wrongTotal.payments![1].amountCents=3199; invalid.push(wrongTotal);
    const zero=input(); zero.payments![0].amountCents=0; zero.payments![1].amountCents=8200; invalid.push(zero);
    const same=input(); same.payments![1].paymentMethod='Dinheiro'; delete same.payments![1].cardEntry; invalid.push(same);
    const entry=input(); entry.payments![0].cardEntry='Inserido'; invalid.push(entry);
    const barter=input(); barter.payments![1].paymentMethod='Permuta'; invalid.push(barter);
    const pending=input(); pending.status='Pendente'; invalid.push(pending);
    const manual=input(); manual.automaticFees=false; invalid.push(manual);
    const manualFee=input(); manualFee.items[0].feeCents=1; invalid.push(manualFee);
    const mismatch=input(); mismatch.paymentMethod='Pix'; invalid.push(mismatch);
    const missing=input(); missing.payments!.pop(); invalid.push(missing);
    const before=records(db);
    for (const order of invalid) {
      assert.throws(()=>register.createSale(saleSchema.parse(order)));
      assert.deepEqual(records(db),before);
    }
    const sameCard=input(); sameCard.paymentMethod='Cartão crédito';
    sameCard.payments=[{paymentMethod:'Cartão crédito',amountCents:5000},{paymentMethod:'Cartão crédito',amountCents:3200,cardEntry:'Aproximação'}];
    assert.throws(()=>register.createSale(saleSchema.parse(sameCard)),/diferentes/);
    const otherEntry={...sameCard,cardEntry:'Inserido' as const,payments:[{paymentMethod:'Cartão crédito' as const,amountCents:5000,cardEntry:'Aproximação' as const},{paymentMethod:'Pix' as const,amountCents:3200}]};
    assert.throws(()=>register.createSale(saleSchema.parse(otherEntry)),/difere/);
    assert.deepEqual(records(db),before);
  } finally { db.close(); }
});

test('falha na última baixa reverte ambas as partes; reenvio exato preserva pedido mesmo após fechamento', () => {
  const {db,register,products,input}=fixture();
  try {
    const last=register.products().find(product=>product.id===products[2].id)!;
    register.saveProduct({...last,stock:0,expectedVersion:last.version},last.id);
    const order=saleSchema.parse(input()), before=records(db);
    assert.throws(()=>register.createSale(order),/Estoque insuficiente/); assert.deepEqual(records(db),before);
    const current=register.products().find(product=>product.id===last.id)!;
    register.saveProduct({...current,stock:5,expectedVersion:current.version},current.id);
    const saved=register.createSale(order);
    const closed=register.closeDay(order.date,cash);
    const changed=register.products().find(product=>product.id===products[0].id)!;
    register.saveProduct({...changed,priceCents:9999,active:false,expectedVersion:changed.version},changed.id);
    const after=records(db);
    assert.deepEqual(register.createSale(order),saved); assert.deepEqual(records(db),after);
    assert.throws(()=>register.createSale({...order,payments:[{...order.payments![0],amountCents:4999},{...order.payments![1],amountCents:3201}]}),/outros valores/);
    assert.deepEqual(register.day(order.date),closed);
    assert.equal(closed.summary.byPayment[0].totalCents,5000); assert.equal(closed.summary.byPayment[3].totalCents,3200);
    assert.throws(()=>register.cancelSale(saved.id),/fechado/); assert.throws(()=>register.deleteSale(saved.id),/fechado/);
    const fair=register.closeFair(order.date);
    assert.equal(fair.summary.paidCount,1); assert.equal(fair.summary.netCents,8101); assert.deepEqual(register.fair(),fair);
  } finally { db.close(); }
});

test('cancelar ou excluir pedido dividido estorna o estoque uma vez e retira as duas partes dos totais', () => {
  const {db,register,input}=fixture();
  try {
    const order=input(), saved=register.createSale(saleSchema.parse(order));
    assert.throws(()=>register.receiveSale(saved.id,order.date,'Dinheiro'),/duas formas/);
    const canceled=register.cancelSale(saved.id);
    assert.equal(canceled.status,'Cancelado'); assert.deepEqual(canceled.payments,saved.payments);
    assert.deepEqual(register.cancelSale(saved.id),canceled);
    assert.equal(register.summary().paidCount,0); assert.equal(register.summary().feeCents,0);
    assert.deepEqual(register.summary().byPayment.map(payment=>payment.totalCents),[0,0,0,0]);
    assert.deepEqual(register.products().map(product=>product.stock),[5,5,5]);
    register.deleteSale(saved.id); register.deleteSale(saved.id);
    assert.equal(register.sales().length,0); assert.deepEqual(register.products().map(product=>product.stock),[5,5,5]);
    assert.throws(()=>register.createSale(saleSchema.parse(order)),/excluído/);
    const paid=register.createSale(saleSchema.parse(input()));
    register.deleteSale(paid.id); register.deleteSale(paid.id);
    assert.equal(register.summary().receivedCents,0); assert.deepEqual(register.products().map(product=>product.stock),[5,5,5]);
  } finally { db.close(); }
});

test('migração v6 adiciona apenas a tabela de pagamentos e mantém valores, hashes, retificações e fechamentos', () => {
  const folder=mkdtempSync(join(tmpdir(),'caixa-migracao-pagamentos-')), path=join(folder,'caixa.sqlite');
  const data=fixture(path); let db=data.db;
  try {
    const {automaticFees,payments: _payments,...legacy}=data.input(); legacy.paymentMethod='Cartão crédito';
    const parsed=saleSchema.parse(legacy);
    assert.equal(Object.hasOwn(parsed,'payments'),false);
    const saved=data.register.createSale(parsed); data.register.closeDay(legacy.date,cash);
    data.register.correctPastCardFees('Retificação anterior à migração');
    db.exec('DROP TABLE sale_payments; PRAGMA user_version = 6');
    const tables=['sales','sale_items','products','fairs','days','spreadsheet_records','stock_adjustments','payment_fee_corrections'];
    const read=()=>tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before=read(); db.close();
    const backup=join(folder,'v6.sqlite'); writeFileSync(backup,readFileSync(path)); const original=readFileSync(backup);
    db=openDatabase(path);
    assert.equal(db.pragma('user_version',{simple:true}),schemaVersion); assert.deepEqual(read(),before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_payments').get()!.n,0);
    const hash=(db.prepare('SELECT request_hash AS hash FROM sales WHERE id=?').get(saved.id) as {hash:string}).hash;
    assert.equal(hash,createHash('sha256').update(JSON.stringify(parsed)).digest('hex'));
    const register=new CashRegister(db), retried=register.createSale(saleSchema.parse(legacy));
    assert.equal(retried.id,saved.id); assert.equal(Object.hasOwn(retried,'payments'),false);
    assert.equal(retried.feeCorrected,true); assert.deepEqual(read(),before);
    assert.equal(register.day(legacy.date).summary.feeCents,0); assert.equal(register.day(legacy.date).adjustedSummary!.feeCents,253);
    assert.deepEqual(readFileSync(backup),original); assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  } finally { if(db.open) db.close(); rmSync(folder,{recursive:true,force:true}); }
});

test('HTTP salva duas partes idempotentemente, exporta valores sem repetição e preserva-as no backup', async () => {
  const {db,register,input}=fixture(), server=createApp(register).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send=(body:unknown)=>fetch(base+'/api/sales',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const folder=mkdtempSync(join(tmpdir(),'caixa-backup-duas-partes-'));
  let restored: Database.Database | undefined;
  try {
    const order=input(), responses=await Promise.all([send(order),send(order)]);
    assert.deepEqual(responses.map(response=>response.status),[201,201]);
    const [saved,repeated]=await Promise.all(responses.map(response=>response.json())); assert.deepEqual(saved,repeated);
    const invalid={...input(),payments:[{paymentMethod:'Dinheiro',amountCents:5000},{paymentMethod:'Cartão crédito',amountCents:3199}]};
    assert.equal((await send(invalid)).status,400);
    assert.equal((await send({...order,payments:invalid.payments})).status,409);
    const csv=(await (await fetch(base+'/api/export/sales.csv')).text()).replace(/^\uFEFF/,'');
    const lines=csv.split('\r\n').map(line=>line.split(';').map(cell=>cell.slice(1,-1).replaceAll('""','"'))), header=lines[0];
    const column=(name:string)=>header.indexOf(name);
    assert.equal(lines.length,4);
    assert.equal(lines[1][column('Pagamento')],'Dinheiro + Cartão crédito (aproximação)');
    assert.equal(lines[1][column('Valor do pagamento 1')],'50,00'); assert.equal(lines[1][column('Valor do pagamento 2')],'32,00');
    assert.equal(lines[1][column('Taxa do pagamento 2')],'0,99');
    for (const row of lines.slice(2)) assert.deepEqual(row.slice(-6),Array(6).fill(''));
    const buffer=Buffer.from(await (await fetch(base+'/api/backup')).arrayBuffer()), backup=join(folder,'backup.sqlite');
    writeFileSync(backup,buffer); restored=new Database(backup,{readonly:true});
    const restoredRegister=new CashRegister(restored);
    assert.deepEqual(restoredRegister.sales(),register.sales()); assert.deepEqual(restoredRegister.summary(),register.summary());
    assert.equal(restored.pragma('integrity_check',{simple:true}),'ok'); assert.deepEqual(restored.pragma('foreign_key_check'),[]);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    restored?.close(); db.close(); rmSync(folder,{recursive:true,force:true});
  }
});
