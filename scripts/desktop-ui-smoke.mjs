import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { openDatabase } from '../apps/api/dist/database.js';
import { CashRegister } from '../apps/api/dist/cash-register.js';

// WebDriver aciona o executável Tauri e o WebKit do sistema, não um navegador.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.env.CAIXA_TEST_DESKTOP_BINARY ?? join(root, 'apps/desktop/src-tauri/target/release/caixa-da-feira-desktop'));
const folder = await mkdtemp(join(tmpdir(), 'caixa-desktop-ui-'));
const database = join(folder, 'ui.sqlite');
const output = join(root, 'test-results/desktop');
const apiPort = 3336;
const driverPort = 4448;
const isolatedEnv = { ...process.env, CAIXA_DB: database, CAIXA_DESKTOP_PORT: String(apiPort),
  XDG_DATA_HOME: join(folder, 'xdg-data'), XDG_CACHE_HOME: join(folder, 'xdg-cache') };
delete isolatedEnv.CAIXA_DESKTOP_RESOURCES;
if (process.env.CAIXA_TEST_DESKTOP_RESOURCES) isolatedEnv.CAIXA_DESKTOP_RESOURCES = resolve(process.env.CAIXA_TEST_DESKTOP_RESOURCES);
let driver;
let abruptApp;
let session;
let driverLog = '';

async function requireFreePort(port) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', error => reject(new Error(`A porta de teste ${port} não está livre: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolvePromise()));
  });
}

async function until(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (cause) { error = cause; }
    await delay(100);
  }
  throw new Error(`Tempo esgotado: ${label}. ${error?.message ?? ''}\n${driverLog.slice(-2500)}`);
}

async function command(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000)
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(result.value)}`);
  return result.value;
}

const execute = (script, args = []) => command('POST', `/session/${session}/execute/sync`, { script, args });
const text = selector => execute('return document.querySelector(arguments[0])?.textContent ?? "";', [selector]);
const click = selector => execute('const el = document.querySelector(arguments[0]); if (!el || el.disabled) throw new Error("Elemento indisponível: " + arguments[0]); el.click();', [selector]);
const navigate = label => execute('const button = [...document.querySelectorAll("nav button")].find(el => el.textContent.trim() === arguments[0]); if (!button) throw new Error("Aba inexistente"); button.click();', [label]);

function dialog(operation, title, path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/usr/bin/python3', [join(root, 'scripts/desktop-dialog-test.py'), operation, title, ...(path ? [path] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise(log.trim()) : reject(new Error(log)));
  });
}

async function saveExport(selector, filename, title = 'Exportar dados do caixa') {
  const path = join(folder, filename);
  await click(selector);
  await dialog('save', title, path);
  const bytes = await until(async () => { const bytes = await readFile(path); return bytes.length ? bytes : false; }, `arquivo ${filename} gravado`);
  await dialog('dismiss', 'Arquivo salvo');
  return bytes;
}
async function newSession() {
  const result = await command('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } });
  session = result.sessionId;
  await until(async () => (await text('h1')).includes('Caixa da feira'), 'interface Angular na janela Tauri');
  await until(async () => (await text('[aria-label="Adicionar Produto desktop"]')).includes('Produto desktop'), 'catálogo do banco isolado');
}

async function listenerIsClosed() {
  try { await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(300) }); return false; }
  catch { return true; }
}

async function closeWindow() {
  await command('DELETE', `/session/${session}/window`);
  await until(listenerIsClosed, 'encerramento do backend após fechar a janela', 10_000);
  await command('DELETE', `/session/${session}`).catch(() => {});
  session = undefined;
}

try {
  // Não usa o banco nem o WebKit LocalStorage do comércio, nem mesmo por origem.
  for (const port of [apiPort, driverPort, 4449]) await requireFreePort(port);
  await mkdir(join(folder, 'xdg-data'), { recursive: true });
  await mkdir(join(folder, 'xdg-cache'), { recursive: true });
  await mkdir(output, { recursive: true });
  const db = openDatabase(database);
  try {
    db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante desktop');
    new CashRegister(db).saveProduct({ name: 'Produto desktop', description: '', ownerId: 1, priceCents: 1500, stock: 10, active: true });
  } finally { db.close(); }
  driver = spawn(join(homedir(), '.cargo/bin/tauri-driver'), ['--port', String(driverPort), '--native-port', '4449'], {
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  driver.on('error', error => { driverLog += error.message; });
  driver.stdout.on('data', chunk => { driverLog += chunk; });
  driver.stderr.on('data', chunk => { driverLog += chunk; });
  await until(async () => {
    if (driver.exitCode !== null || driver.signalCode !== null) throw new Error('O driver iniciado encerrou antes da confirmação.');
    const response = await fetch(`http://127.0.0.1:${driverPort}/status`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  }, 'driver WebKit pronto');
  await newSession();
  const applicationRoute = await fetch(`http://127.0.0.1:${apiPort}/historico`);
  assert.equal(applicationRoute.status, 200, 'fallback da interface sob a pasta de instalação .local');
  assert.match(await applicationRoute.text(), /<app-root>/);
  console.log('Janela WebKit:', await execute('return {width: innerWidth, height: innerHeight, scale: devicePixelRatio, screenWidth: screen.availWidth, screenHeight: screen.availHeight, columns: getComputedStyle(document.querySelector(".sales-layout")).gridTemplateColumns};'));
  assert.equal(await execute('const panels = document.querySelectorAll(".sales-layout > section"); return Math.abs(panels[0].getBoundingClientRect().top - panels[1].getBoundingClientRect().top) < 2;'), true,
    'Produtos e pedido devem aparecer lado a lado no tamanho inicial do notebook.');
  await click('[aria-label="Adicionar Produto desktop"]');
  await until(async () => (await text('[data-testid="cart-total"]')).includes('15,00'), 'carrinho atualizado');
  const screenshot = await command('GET', `/session/${session}/screenshot`);
  await writeFile(join(output, 'tauri-webkit.png'), Buffer.from(screenshot, 'base64'));
  // A segunda abertura deve sair sem iniciar outro Node nem trocar o banco.
  const duplicate = spawn(binary, [], { env: { ...isolatedEnv, CAIXA_DB: join(folder, 'never-open.sqlite') }, stdio: 'ignore' });
  await until(() => duplicate.exitCode !== null, 'segunda instância encerrada', 5000);
  assert.equal(duplicate.exitCode, 0);
  await assert.rejects(readFile(join(folder, 'never-open.sqlite')), { code: 'ENOENT' });
  assert.equal(await listenerIsClosed(), false);
  await closeWindow();
  await newSession();
  await until(async () => (await text('[data-testid="cart-total"]')).includes('15,00'), 'rascunho preservado após reabrir');
  await click('button[type="submit"]');
  await until(async () => (await text('[data-testid="cart-total"]')).includes('0,00'), 'pedido salvo e carrinho limpo');
  const date = await execute('return document.querySelector(".date-field input").value;');
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/bootstrap?date=${encodeURIComponent(date)}`);
  assert.equal(response.ok, true);
  const bootstrap = await response.json();
  assert.equal(bootstrap.sales.length, 1);
  assert.equal(bootstrap.sales[0].totalCents, 1500);
  assert.equal(bootstrap.products[0].stock, 9);
  await navigate('Histórico');
  await until(async () => (await text('.history-order')).includes('Produto desktop'), 'pedido no histórico WebKit');
  const csv = await saveExport('a[href^="/api/export/sales.csv"]', 'sales.csv');
  assert.match(csv.toString('utf8'), /Produto desktop/);
  await saveExport('a[href="/api/export/fairs.csv"]', 'fairs.csv');
  await saveExport('a[href="/api/backup"]', 'backup.sqlite', 'Salvar backup do caixa');
  const exported = openDatabase(join(folder, 'backup.sqlite'));
  try {
    assert.equal(exported.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(new CashRegister(exported).sales().length, 1);
  } finally { exported.close(); }
  // A confirmação é Angular: funciona no WebKit sem depender de window.confirm.
  await click('.history-order .delete-order');
  await until(async () => (await text('.delete-confirmation')).includes('15,00'), 'confirmação de exclusão exibida');
  const beforeConfirm = await (await fetch(`http://127.0.0.1:${apiPort}/api/bootstrap?date=${encodeURIComponent(date)}`)).json();
  assert.equal(beforeConfirm.sales.length, 1, 'abrir confirmação não exclui o pedido');
  const deleteScreenshot = await command('GET', `/session/${session}/screenshot`);
  await writeFile(join(output, 'tauri-excluir-pedido.png'), Buffer.from(deleteScreenshot, 'base64'));
  await click('.delete-confirmation .secondary');
  await until(async () => await execute('return document.querySelector(".delete-confirmation") === null;'), 'Voltar fecha a confirmação');
  await click('.history-order .delete-order');
  await until(async () => (await text('.delete-confirmation')).includes('15,00'), 'confirmação reaberta');
  await click('.delete-confirm-button');
  await until(async () => await execute('return document.querySelectorAll(".history-order").length === 0;'), 'pedido excluído no histórico WebKit');
  const corrected = await (await fetch(`http://127.0.0.1:${apiPort}/api/bootstrap?date=${encodeURIComponent(date)}`)).json();
  assert.equal(corrected.sales.length, 0); assert.equal(corrected.products[0].stock, 10);
  assert.equal(corrected.fair.summary.netCents, 0);
  const correctedCsv = await (await fetch(`http://127.0.0.1:${apiPort}/api/export/sales.csv`)).text();
  assert.equal(correctedCsv.includes(bootstrap.sales[0].id), false);
  await closeWindow();
  const restored = openDatabase(database);
  try {
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(restored.pragma('foreign_key_check'), []);
    assert.equal(new CashRegister(restored).sales().length, 0);
    assert.equal(new CashRegister(restored).products()[0].stock, 10);
    assert.ok(restored.prepare('SELECT deleted_at FROM sales WHERE id=?').get(bootstrap.sales[0].id)?.deleted_at);
  } finally { restored.close(); }
  // Verifica também a morte abrupta do pai, fora da sessão de automação WebKit.
  abruptApp = spawn(binary, [], { env: isolatedEnv, stdio: 'ignore' });
  await until(async () => !(await listenerIsClosed()), 'nova abertura antes da interrupção abrupta');
  abruptApp.kill('SIGKILL');
  await until(listenerIsClosed, 'Node encerrado pelo kernel após morte abrupta do pai', 10_000);
  console.log('Desktop WebKit: janela Angular, segunda instância, rascunho após reabrir, pedido/estoque, exportações com diálogo, backup, confirmação/exclusão e encerramento normal/abrupto passaram.');
} finally {
  if (session) await command('DELETE', `/session/${session}/window`).catch(() => {});
  if (session) await command('DELETE', `/session/${session}`).catch(() => {});
  if (abruptApp && abruptApp.exitCode === null && abruptApp.signalCode === null) abruptApp.kill('SIGKILL');
  if (driver && driver.exitCode === null) {
    driver.kill('SIGTERM');
    await until(() => driver.exitCode !== null || driver.signalCode !== null, 'encerramento do driver', 5000).catch(() => driver.kill('SIGKILL'));
  }
  await writeFile(join(output, 'webdriver.log'), driverLog).catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
