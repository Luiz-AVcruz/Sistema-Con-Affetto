import { spawn } from 'node:child_process';

// O teste inteiro roda na sandbox instalada, sem abrir janela ou banco de uso.
async function sandboxSmoke() {
  const { default: assert } = await import('node:assert/strict');
  const { spawn, execFileSync } = await import('node:child_process');
  const { mkdtemp, readFile, writeFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir, networkInterfaces } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID, createHash } = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const resources = '/app/lib/caixa-da-feira/resources';
  const require = createRequire(`${resources}/server.mjs`);
  const Database = require('better-sqlite3');
  const folder = await mkdtemp(join(tmpdir(), 'caixa-flatpak-test-'));
  const database = join(folder, 'isolado.sqlite');
  let server;
  let closed;
  let log = '';
  let spawnError;

  async function bounded(promise, label, timeout = 10_000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tempo esgotado: ${label}. ${log}`)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  try {
    assert.equal((await readFile('/proc/net/route', 'utf8')).trim().split('\n').length, 1, 'runtime sem rota para rede externa');
    assert.equal(Object.values(networkInterfaces()).flat().every(address => address.internal), true,
      'somente interfaces internas, incluindo IPv4 e IPv6');
    const gc = execFileSync(process.execPath, ['--eval', `
      const { createRequire } = require('node:module');
      const Database = createRequire('${resources}/server.mjs')('better-sqlite3');
      for (let round = 0; round < 10000; round++) {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE teste(id INTEGER); INSERT INTO teste VALUES(1)');
        db.prepare('SELECT * FROM teste').all(); db.close();
        const allocations = Array.from({length:100}, () => ({content:'x'.repeat(200)}));
      }
      console.log('Coleta nativa concluída');
    `], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    assert.match(gc, /Coleta nativa concluída/, 'coleta real sem preloader nem banco de uso');
    await assert.rejects(stat(`${resources}/node_modules/better-sqlite3/prebuilds`), error => error.code === 'ENOENT');
    server = spawn(process.execPath, [`${resources}/server.mjs`], {
      env: { ...process.env, CAIXA_DB: database, CAIXA_FRONTEND: `${resources}/frontend`, CAIXA_DESKTOP: '1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    closed = new Promise(resolve => server.once('close', (code, signal) => resolve({ code, signal })));
    server.on('error', error => { spawnError = error; });
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    const port = await bounded((async () => {
      for (;;) {
        if (spawnError) throw spawnError;
        if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Backend encerrou: ${log}`);
        const marker = log.match(/CAIXA_READY (\{[^\n]+\})/);
        if (marker) return JSON.parse(marker[1]).port;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })(), 'backend pronto');
    const base = `http://127.0.0.1:${port}`;
    async function api(path, body) {
      const response = await fetch(`${base}${path}`, body === undefined ? { signal: AbortSignal.timeout(3000) } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000)
      });
      assert.equal(response.ok, true, `${path}: ${await response.clone().text()}`);
      return response.json();
    }
    assert.equal((await api('/api/health')).status, 'ok');
    assert.match(await (await fetch(`${base}/historico`)).text(), /<app-root>/, 'frontend empacotado');
    const owner = await api('/api/owners', { name: 'Participante de teste isolado' });
    const product = await api('/api/products', { name: 'Produto de teste isolado', description: '', ownerId: owner.id, priceCents: 1500, stock: 10, active: true });
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const sale = { requestId: randomUUID(), date, paymentMethod: 'Dinheiro', status: 'Pago', note: '',
      items: [{ productId: product.id, quantity: 1, expectedPriceCents: 1500, discountCents: 0, feeCents: 0 }] };
    assert.equal((await api('/api/sales', sale)).totalCents, 1500);
    assert.equal((await api('/api/sales', sale)).id, sale.requestId);
    const state = await api(`/api/bootstrap?date=${date}`);
    assert.equal(state.sales.length, 1, 'retry não duplica');
    assert.equal(state.products[0].stock, 9, 'uma única baixa de estoque');
    assert.match(await (await fetch(`${base}/api/export/sales.csv`)).text(), /Produto de teste isolado/);
    const backup = join(folder, 'backup.sqlite'), restored = join(folder, 'restaurado.sqlite');
    await writeFile(backup, Buffer.from(await (await fetch(`${base}/api/backup`)).arrayBuffer()));
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const originalHash = hash(await readFile(backup));
    const restoration = execFileSync('/app/bin/caixa-restaurar-backup', [backup, restored], { encoding: 'utf8' });
    assert.match(restoration, /restaurada e validada/);
    assert.equal(hash(await readFile(backup)), originalHash, 'origem do backup preservada');
    const restoredDb = new Database(restored, { readonly: true, fileMustExist: true });
    try {
      assert.equal(Object.keys(require.cache).includes(`${resources}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`), true,
        'addon compilado e normalizado realmente carregado');
      assert.equal(restoredDb.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(restoredDb.pragma('foreign_key_check'), []);
      assert.equal(restoredDb.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      assert.equal(restoredDb.prepare('SELECT stock FROM products').get().stock, 9);
    } finally { restoredDb.close(); }
    assert.throws(() => execFileSync('/app/bin/caixa-restaurar-backup', [backup, restored], { stdio: 'pipe' }), 'destino existente recusado');
    const preload = join(folder, 'falha-fsync.mjs'), published = join(folder, 'publicado.sqlite');
    await writeFile(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const sync = fs.fsyncSync;
fs.fsyncSync = fd => {
  if (fs.fstatSync(fd).isDirectory()) throw new Error('Falha isolada ao sincronizar diretório');
  return sync(fd);
};
syncBuiltinESMExports();`);
    assert.throws(() => execFileSync(process.execPath, ['--import', preload,
      `${resources}/scripts/restaurar-backup.mjs`, backup, published], { stdio: 'pipe' }),
      error => error.status === 1 && /Falha isolada ao sincronizar diretório/.test(error.stderr.toString()));
    const publishedDb = new Database(published, { readonly: true, fileMustExist: true });
    try {
      assert.equal(publishedDb.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(publishedDb.pragma('foreign_key_check'), []);
      assert.equal(publishedDb.prepare('SELECT COUNT(*) AS n FROM sales').get().n, 1);
      assert.equal(publishedDb.prepare('SELECT stock FROM products').get().stock, 9);
    } finally { publishedDb.close(); }
    assert.equal(hash(await readFile(backup)), originalHash);
    server.kill('SIGTERM');
    assert.deepEqual(await bounded(closed, 'encerramento por SIGTERM'), { code: 0, signal: null });
    await assert.rejects(fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }));
    const persisted = new Database(database, { readonly: true, fileMustExist: true });
    try { assert.equal(persisted.pragma('integrity_check', { simple: true }), 'ok'); }
    finally { persisted.close(); }
    console.log(`Flatpak runtime passou: Node ${process.version}, better-sqlite3 ${require('better-sqlite3/package.json').version}, coleta de wrappers, addon compilado, rede privada IPv4/IPv6, frontend, pedido/retry/estoque, CSV, backup/restauração, falha após publicação e SIGTERM.`);
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await bounded(closed, 'limpeza do backend').catch(async () => {
        server.kill('SIGKILL');
        await bounded(closed, 'limpeza forçada do backend');
      });
    }
    await rm(folder, { recursive: true, force: true });
  }
}

const child = spawn('flatpak', ['run', '--command=/app/lib/caixa-da-feira/resources/bin/node',
  'br.com.caixadafeira.local', '--input-type=module'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.stdin.on('error', () => {});
child.stdin.end(`await (${sandboxSmoke.toString()})();`);
child.on('close', (code, signal) => { process.exitCode = signal || code !== 0 ? 1 : 0; });
