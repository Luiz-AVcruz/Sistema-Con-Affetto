import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { CashRegister } from '../src/cash-register.js';
import { createApp } from '../src/app.js';

let baseUrl: string, server: Server | undefined, db: Database.Database | undefined;
before(async () => {
  if (process.env['CAIXA_TEST_URL']) {
    const url = new URL(process.env['CAIXA_TEST_URL']);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port !== '3333', 'Use uma API local de teste, nunca a porta 3333 do caixa real.');
    baseUrl = url.origin;
  } else {
    db = openDatabase(':memory:');
    server = createApp(new CashRegister(db)).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});
after(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); if (db?.open) db.close(); });
async function api(path: string, body?: unknown, method = 'POST') {
  return fetch(baseUrl+path, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

test('contrato HTTP: pedido misto, reenvio concorrente, valores inválidos, CSV e backup', async () => {
  const suffix = randomUUID();
  const ownerA = await (await api('/api/owners', { name: 'Teste A '+suffix })).json();
  const ownerB = await (await api('/api/owners', { name: 'Teste B '+suffix })).json();
  const productA = await (await api('/api/products', { name: 'Teste 15 '+suffix, description: '', ownerId: ownerA.id, priceCents: 1500, stock: 10, active: true })).json();
  const productB = await (await api('/api/products', { name: 'Teste 40 '+suffix, description: '', ownerId: ownerB.id, priceCents: 4000, stock: 3, active: true })).json();
  const input = { requestId: randomUUID(), date: '2026-10-10', paymentMethod: 'Pix', status: 'Pago', note: '=1+1',
    items: [productA, productB].map(product => ({ productId: product.id, quantity: 1, expectedPriceCents: product.priceCents, discountCents: 0, feeCents: 0 })) };
  const results = await Promise.all([api('/api/sales', input), api('/api/sales', input)]);
  assert.deepEqual(results.map(result => result.status), [201,201]);
  const sale = await results[0].json(); assert.equal(sale.totalCents, 5500);
  assert.equal(sale.origin, 'Aplicativo');
  assert.match(sale.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal((await results[1].json()).createdAt, sale.createdAt);
  let data = await (await api('/api/bootstrap?date=2026-10-10')).json();
  assert.equal(data.sales.filter((row: { id: string }) => row.id === input.requestId).length, 1);
  assert.equal(data.products.find((product: { id: number }) => product.id === productA.id).stock, 9);
  assert.equal(data.products.find((product: { id: number }) => product.id === productB.id).stock, 2);
  assert.equal(data.day.summary.byOwner.find((owner: { ownerId: number }) => owner.ownerId === ownerA.id).netCents, 1500);
  assert.equal(data.day.summary.byOwner.find((owner: { ownerId: number }) => owner.ownerId === ownerB.id).netCents, 4000);
  const invalid = await api('/api/sales', { ...input, requestId: randomUUID(), items: [{ ...input.items[0], quantity: 0.5 }] });
  assert.equal(invalid.status, 400);
  const insufficient = await api('/api/sales', { ...input, requestId: randomUUID(), items: [{ ...input.items[0], quantity: 1 }, { ...input.items[1], quantity: 99 }] });
  assert.equal(insufficient.status, 409);
  data = await (await api('/api/bootstrap?date=2026-10-10')).json();
  assert.equal(data.products.find((product: { id: number }) => product.id === productA.id).stock, 9);
  const csv = await (await api('/api/export/sales.csv')).text();
  assert.ok(csv.includes('"\'=1+1"')); assert.ok(csv.includes('"15,00"')); assert.ok(csv.includes('"Líquido recebido"'));
  assert.ok(csv.includes('"Registrado em (UTC)"')); assert.ok(csv.includes(`"${sale.createdAt}";"Aplicativo"`));
  const backup = Buffer.from(await (await api('/api/backup')).arrayBuffer());
  assert.equal(backup.subarray(0,16).toString(), 'SQLite format 3\0');
  const folder = mkdtempSync(join(tmpdir(), 'caixa-download-')), path = join(folder, 'backup.sqlite');
  writeFileSync(path, backup);
  const restored = new Database(path, { readonly: true });
  try { assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); }
  finally { restored.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('proteção HTTP: rejeita origem externa, Host externo e envio por formulário', async () => {
  const origin = await fetch(baseUrl+'/api/owners', { method: 'POST', headers: { Origin: 'https://externo.example', 'Content-Type': 'application/json' }, body: '{"name":"externa"}' });
  assert.equal(origin.status, 403);
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(baseUrl+'/api/health', { headers: { Host: 'externo.example' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode!));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  const form = await fetch(baseUrl+'/api/owners', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=externa' });
  assert.equal(form.status, 415);
});

test('interface instalada sob .local atende rotas da aplicação sem liberar arquivos ocultos', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-frontend-local-'));
  const frontend = join(folder, '.local/share/caixa-da-feira/resources/frontend');
  mkdirSync(frontend, { recursive: true });
  const html = '<!doctype html><html><app-root>Interface temporária</app-root></html>';
  writeFileSync(join(frontend, 'index.html'), html);
  writeFileSync(join(frontend, 'styles.css'), 'body { margin: 0; }');
  writeFileSync(join(frontend, '.private'), 'conteúdo interno que não pode ser servido');
  const temporaryDb = openDatabase(':memory:');
  const temporaryServer = createApp(new CashRegister(temporaryDb), frontend).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => temporaryServer.once('listening', resolve));
  const url = `http://127.0.0.1:${(temporaryServer.address() as AddressInfo).port}`;
  try {
    for (const path of ['/', '/historico', '/historico/pedido', '/favicon.ico']) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200, path); assert.equal(await response.text(), html);
    }
    const style = await fetch(url + '/styles.css'); assert.equal(style.status, 200);
    assert.match(style.headers.get('content-type') ?? '', /text\/css/);
    const hidden = await fetch(url + '/.private'); assert.equal(await hidden.text(), html);
    const missingApi = await fetch(url + '/api/inexistente'); assert.equal(missingApi.status, 404);
  } finally {
    await new Promise<void>(resolve => temporaryServer.close(() => resolve()));
    temporaryDb.close(); rmSync(folder, { recursive: true, force: true });
  }
});
