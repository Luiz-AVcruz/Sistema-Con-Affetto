import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { fairSchema, newFairSchema } from '../src/validation.js';
import type { SaleInput } from '@caixa/shared';

const cash = { openingCents:1000,extraCents:200,withdrawalCents:100,countedCents:null,note:'Conferência salva' };
function fixture() {
  const db = openDatabase(':memory:'), register = new CashRegister(db);
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante');
  const product = register.saveProduct({name:'Produto',description:'',ownerId:1,priceCents:1500,stock:10,active:true});
  const order = (overrides:Partial<SaleInput> = {}):SaleInput => ({requestId:randomUUID(),date:'2026-10-10',paymentMethod:'Dinheiro',status:'Pago',note:'',
    items:[{productId:product.id,quantity:1,expectedPriceCents:1500,discountCents:100,feeCents:20}],...overrides});
  return { db,register,product,order };
}

test('meta opcional aceita centavos inteiros positivos e não muda receitas ou itens', () => {
  const { db,register,order } = fixture();
  try {
    const sale=register.createSale(order()), before=register.products();
    register.saveFair(fairSchema.parse({name:'Feira outubro',targetCents:20000}));
    assert.equal(register.fair().targetCents,20000); assert.equal(register.fair().summary.netCents,1380);
    assert.deepEqual(register.sales(),[sale]); assert.deepEqual(register.products(),before);
    assert.equal(register.saveFair({name:'Sem meta',targetCents:null}).targetCents,null);
    for (const targetCents of [0,-1,0.5]) assert.throws(() => fairSchema.parse({name:'Feira',targetCents}));
    assert.throws(() => newFairSchema.parse({name:'Feira',targetCents:null,startDate:'2026-02-30'}));
  } finally { db.close(); }
});

test('encerramento fixa o resumo e as conferências salvas; uma nova feira no mesmo dia tem fechamento próprio e estoque compartilhado', () => {
  const { db,register,product,order } = fixture();
  try {
    const sale=register.createSale(order()); register.saveDay('2026-10-10',cash);
    register.saveFair({name:'Primeira',targetCents:10000});
    const closed=register.closeFair('2026-10-10'), day=register.day('2026-10-10');
    assert.ok(closed.closedAt); assert.equal(closed.summary.netCents,1380); assert.equal(day.expectedCents,2500);
    assert.equal(day.countedCents,null); assert.equal(day.note,cash.note); assert.ok(day.closedAt);
    assert.deepEqual(register.closeFair('2026-10-10'),closed);
    assert.deepEqual(register.createSale({...order(),...{requestId:sale.id},items:sale.items.map(item=>({productId:item.productId,quantity:item.quantity,expectedPriceCents:item.priceCents,discountCents:item.discountCents,feeCents:item.feeCents}))}),sale);
    for (const action of [()=>register.saveFair({name:'Alterada',targetCents:1}),()=>register.createSale(order()),()=>register.cancelSale(sale.id),()=>register.saveDay('2026-10-11',cash)]) {
      assert.throws(action,/encerrada/);
    }
    const next=register.createFair({name:'Segunda',targetCents:5000,startDate:'2026-10-10'}), active=new CashRegister(db);
    assert.equal(active.fairId,next.id); assert.equal(active.sales().length,0); assert.equal(active.summary().netCents,0);
    active.createSale(order({fairId:next.id}));
    active.closeDay('2026-10-10',{...cash,openingCents:0,extraCents:0,withdrawalCents:0,note:'Novo caixa'});
    const changed=active.products().find(item=>item.id===product.id)!;
    active.saveProduct({...changed,name:'Novo nome',priceCents:9000,expectedVersion:changed.version},product.id);
    db.prepare('INSERT INTO owners(name) VALUES(?)').run('Participante futuro');
    assert.equal(active.products()[0].stock,8); assert.deepEqual(register.fair(),closed); assert.deepEqual(register.day('2026-10-10'),day);
    assert.equal(active.day('2026-10-10').expectedCents,1400); assert.equal(active.bootstrap('2026-10-10').activeFairId,next.id);
    assert.equal(register.bootstrap('2026-10-10').total.netCents,1380); assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
    assert.throws(()=>register.createFair({name:'Terceira',targetCents:null,startDate:'2026-10-10'}),/Encerre/);
    assert.throws(()=>active.cancelSale(sale.id),/inexistente/);
  } finally { db.close(); }
});

test('pendência de valor zero, recebimento futuro e conferência futura impedem encerramento sem alterar banco', () => {
  const { db,register,product,order } = fixture();
  try {
    const pending=register.createSale(order({status:'Pendente',items:[{productId:product.id,quantity:1,expectedPriceCents:1500,discountCents:1500,feeCents:0}]}));
    const before=db.serialize(); assert.throws(()=>register.closeFair('2026-10-10'),/pendentes/); assert.deepEqual(db.serialize(),before);
    register.receiveSale(pending.id,'2026-10-11','Pix');
    assert.throws(()=>register.closeFair('2026-10-10'),/anterior/); assert.equal(register.fair().closedAt,null);
    register.saveDay('2026-10-12',cash); assert.throws(()=>register.closeFair('2026-10-11'),/anterior/);
    register.closeFair('2026-10-12');
    assert.throws(()=>register.createFair({name:'Nova',targetCents:null,startDate:'2026-10-11'}),/anterior/);
  } finally { db.close(); }
});

test('HTTP preserva contexto em retry de pedido antigo, impede misturar feiras e exporta metas, recebimentos e dias de ambas', async () => {
  const { db,register,order }=fixture(); const server=createApp(register).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const api=(path:string,body?:unknown,method='POST')=>fetch(base+path,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    const input=order(); assert.equal((await api('/api/sales',input)).status,201);
    assert.equal((await api('/api/fairs/1',{name:'=Feira primeira',targetCents:8000},'PUT')).status,200);
    assert.equal((await api('/api/fairs/1/close',{date:'2026-10-10'})).status,200);
    const next=await (await api('/api/fairs',{name:'Segunda',targetCents:null,startDate:'2026-10-10'})).json();
    assert.equal((await api('/api/sales',input)).status,409);
    assert.equal((await api('/api/sales',{...input,fairId:1})).status,201);
    assert.equal((await api('/api/sales',{...order(),fairId:1})).status,409);
    assert.equal((await api('/api/sales',{...order(),fairId:next.id})).status,201);
    assert.equal((await api(`/api/sales/${input.requestId}/cancel?fairId=1`,{})).status,409);
    assert.equal((await api('/api/days/2026-10-10?fairId=1',cash,'PUT')).status,409);
    const archived=await (await api('/api/bootstrap?date=2026-10-10&fairId=1')).json();
    assert.equal(archived.sales.length,1); assert.equal(archived.fair.targetCents,8000); assert.equal(archived.activeFairId,next.id);
    const all=await (await api('/api/export/sales.csv')).text(), first=await (await api('/api/export/sales.csv?fairId=1')).text();
    assert.equal(all.trim().split('\r\n').length,3); assert.equal(first.trim().split('\r\n').length,2);
    assert.ok(all.includes('"Segunda"')); assert.ok(first.includes('"\'=Feira primeira"')); assert.ok(!first.includes('"Segunda"'));
    const fairs=await(await api('/api/export/fairs.csv')).text();
    assert.ok(fairs.includes('"80,00"')); assert.ok(fairs.includes('"13,80"')); assert.ok(fairs.includes('"Parte de Participante"'));
    const days=await(await api('/api/export/days.csv?fairId=1')).text(); assert.ok(days.includes('"Fechado"'));
    assert.equal((await api('/api/bootstrap?date=2026-10-10&fairId=999')).status,404);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); db.close(); }
});
