import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'apps/desktop/src-tauri/resources');
const node = join(resources, 'bin/node');
const serverScript = join(resources, 'server.mjs');

function waitForReady(child, timeoutMs = 12_000) {
  return new Promise((resolvePromise, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error('Tempo esgotado aguardando CAIXA_READY.')), timeoutMs);
    const onExit = (code, signal) => finish(new Error(`Servidor saiu antes de ficar pronto (code=${code}, signal=${signal}).\n${child.desktopStderr || ''}`));
    function finish(error, value) {
      clearTimeout(timer);
      lines.close();
      child.off('exit', onExit);
      if (error) reject(error); else resolvePromise(value);
    }
    lines.on('line', line => {
      if (!line.startsWith('CAIXA_READY ')) return;
      try {
        const { port } = JSON.parse(line.slice('CAIXA_READY '.length));
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('porta inválida');
        finish(undefined, port);
      } catch (error) { finish(new Error(`Marcador CAIXA_READY inválido: ${error.message}`)); }
    });
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`O PID ${child.pid} não encerrou em ${timeoutMs} ms.`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function launch(database, port) {
  const child = spawn(node, [serverScript], {
    cwd: root,
    env: { ...process.env, CAIXA_DESKTOP: '1', CAIXA_DB: database, CAIXA_FRONTEND: join(resources, 'frontend'), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.desktopStderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { child.desktopStderr += chunk; });
  return child;
}

async function requireHealthy(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Servidor local respondeu com HTTP ${response.status}.`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error('Resposta de saúde do servidor local inválida.');
  return body;
}

const tempRoot = await mkdtemp(join(tmpdir(), 'caixa-desktop-runtime-'));
let owner;
let contender;
try {
  owner = launch(join(tempRoot, 'owner.sqlite'), 0);
  const port = await waitForReady(owner);
  await requireHealthy(port);

  contender = launch(join(tempRoot, 'contender.sqlite'), port);
  const duplicateExit = await waitForExit(contender, 5000);
  if (duplicateExit.code === 0) throw new Error('Uma segunda instância do servidor assumiu a porta da instância ativa.');
  await requireHealthy(port);

  owner.kill('SIGTERM');
  const ownerExit = await waitForExit(owner, 8000);
  if (ownerExit.code !== 0) throw new Error(`O servidor não encerrou normalmente após SIGTERM: ${JSON.stringify(ownerExit)}.`);
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
    throw new Error('A porta continuou respondendo depois do encerramento do processo dono.');
  } catch (error) {
    if (error.message.includes('continuou respondendo')) throw error;
    // fetch deve falhar depois do SIGTERM e do fechamento do listener.
  }

  console.log(`Smoke do backend desktop passou: porta efêmera ${port}, colisão não tomou o servidor existente e SIGTERM encerrou o dono.`);
} finally {
  if (contender && contender.exitCode === null) { contender.kill('SIGKILL'); await waitForExit(contender).catch(() => {}); }
  if (owner && owner.exitCode === null) { owner.kill('SIGKILL'); await waitForExit(owner).catch(() => {}); }
  await rm(tempRoot, { recursive: true, force: true });
}
