import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = resolve(process.env['CAIXA_DESKTOP_RESOURCES_DIR'] ?? join(root, 'apps/desktop/src-tauri/resources'));
const cacheName = '.nightly-cache.json';
const cachePath = join(resources, cacheName);

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fingerprint(paths, skip = () => false, metadata = '', changes) {
  const hash = createHash('sha256').update(metadata);
  async function visit(path, ancestors = new Set()) {
    if (skip(path)) return;
    const info = await stat(path, { bigint: true });
    hash.update(JSON.stringify([path, Number(info.mode) & 0o777, info.isDirectory() ? 'directory' : 'file']));
    if (changes) {
      const link = await lstat(path, { bigint: true });
      // ctime detecta A → B → A, mesmo que o editor restaure conteúdo e mtime.
      // Diretórios comuns mudam ao gerar dist/.angular; esses artefatos são ignorados.
      for (const entry of [!info.isDirectory() && info, link.isSymbolicLink() && link].filter(Boolean)) {
        changes.update(JSON.stringify([path, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(entry[key]))]));
      }
    }
    if (info.isDirectory()) {
      // stat segue links: a identidade do diretório impede uma recursão circular.
      const identity = `${info.dev}:${info.ino}`;
      if (ancestors.has(identity)) throw new Error(`Link circular nos recursos da Nightly: ${path}`);
      const next = new Set(ancestors).add(identity);
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), next);
    } else {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    }
    hash.update('\0');
  }
  for (const path of paths) {
    if (await exists(path)) await visit(path);
    else hash.update(JSON.stringify([path, 'missing']));
  }
  return hash.digest('hex');
}

async function inputSnapshot() {
  const changes = createHash('sha256');
  const installed = join(root, 'node_modules/.package-lock.json');
  // npm recria este arquivo ao instalar, mesmo se as versões continuarem iguais.
  const installedTime = await exists(installed) ? String((await stat(installed, { bigint: true })).mtimeNs) : null;
  const sqlite = join(root, 'node_modules/better-sqlite3');
  const sqlitePackage = JSON.parse(await readFile(join(sqlite, 'package.json'), 'utf8'));
  const builtAddon = join(sqlite, 'build/Release/better_sqlite3.node');
  const addon = await exists(builtAddon) ? builtAddon : join(sqlite, `prebuilds/${process.platform}-${process.arch}.node`);
  const inputs = [
    'package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'tsconfig.json', 'tsconfig.base.json',
    'apps/api', 'apps/web', 'packages/shared', 'apps/desktop/package.json', 'apps/desktop/src-tauri/error.html',
    'scripts/desktop-prepare.mjs', 'scripts/nightly-prepare.mjs', 'node_modules/.package-lock.json'
  ].map(path => join(root, path));
  const configurations = [];
  // O Angular procura Browserslist também fora de apps/web, até a raiz do disco.
  for (let directory = join(root, 'apps/web'); ; directory = dirname(directory)) {
    for (const name of ['package.json', '.browserslistrc', 'browserslist', 'browserslist-stats.json']) configurations.push(join(directory, name));
    if (directory === dirname(directory)) break;
  }
  for (const name of ['BROWSERSLIST_CONFIG', 'BROWSERSLIST_STATS']) {
    if (process.env[name]) configurations.push(resolve(root, 'apps/web', process.env[name]));
  }
  const sourceKey = await fingerprint(inputs, path => relative(root, path).split('/').slice(2).some(name => ['dist', '.angular', 'node_modules', '.git'].includes(name)), '', changes);
  const configKey = await fingerprint([...new Set(configurations)], () => false, '', changes);
  const runtimeModules = [sqlite];
  if (sqlitePackage.dependencies?.bindings) runtimeModules.push(join(root, 'node_modules/bindings'), join(root, 'node_modules/file-uri-to-path'));
  const runtimeKey = await fingerprint(runtimeModules, path => /(?:^|\/)(?:test|tests|benchmark|benchmark\.js|\.github|build|prebuilds)(?:\/|$)/.test(relative(join(root, 'node_modules'), path)), '', changes);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:BROWSERSLIST(?:_|$)|NG_BUILD_|NODE_OPTIONS$|NODE_ENV$)/.test(name)).sort(([a], [b]) => a.localeCompare(b)));
  const key = await fingerprint([process.execPath, addon], () => false, JSON.stringify({
    version: 1, root, sourceKey, configKey, runtimeKey, installedTime, node: process.version,
    platform: process.platform, arch: process.arch, abi: process.versions.modules,
    environment
  }), changes);
  return { key, changes: changes.digest('hex') };
}

async function outputKey() {
  for (const path of ['bin/node', 'server.mjs', 'frontend/index.html', 'frontend/desktop-error.html',
    'manifest.json', 'node_modules/better-sqlite3/package.json', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
    if (!await exists(join(resources, path))) throw new Error(`Recurso da Nightly ausente: ${path}`);
  }
  return fingerprint([resources], path => path === cachePath || path === `${cachePath}.tmp`);
}

async function waitForGroup(group) {
  // O fechamento do filho direto não atesta o término de npm/Angular/esbuild.
  // SIGKILL solicita término; aguardar /proc mantém a trava até cessar o escritor.
  for (;;) {
    let running = false;
    for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      try {
        const record = await readFile(`/proc/${pid}/stat`, 'utf8');
        const [state, , processGroup] = record.slice(record.lastIndexOf(')') + 2).split(' ');
        if (Number(processGroup) === group && state !== 'Z' && state !== 'X') { running = true; break; }
      } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
    }
    if (!running) return;
    await delay(10);
  }
}

async function prepare() {
  const before = await inputSnapshot();
  try {
    const saved = JSON.parse(await readFile(cachePath, 'utf8'));
    if (saved.formatVersion === 1 && saved.inputKey === before.key && saved.outputKey === await outputKey()) {
      console.log('Nightly: recursos atuais; reutilizando a compilação.');
      return;
    }
  } catch { /* Cache ausente, incompleto ou danificado: preparar novamente. */ }

  await rm(cachePath, { force: true });
  console.log('Nightly: preparando recursos alterados ou ausentes.');
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/desktop-prepare.mjs')], {
      cwd: root, stdio: 'inherit', detached: true, env: { ...process.env, CAIXA_DESKTOP_RESOURCES_DIR: resources }
    });
    let interrupted, timer, finished = false;
    const stop = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const handlers = ['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
      interrupted = signal;
      // Inclui npm, Angular e seus filhos; só então o launcher pode soltar a trava.
      stop(signal);
      timer ??= setTimeout(() => stop('SIGKILL'), 1000);
    }]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = async error => {
      if (finished) return;
      finished = true;
      stop('SIGKILL');
      if (child.pid) await waitForGroup(child.pid);
      clearTimeout(timer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (interrupted) reject(new Error(`Preparação da Nightly interrompida: ${interrupted}.`));
      else if (error) reject(error);
      else accept();
    };
    child.once('error', error => { finish(error).catch(reject); });
    child.once('close', (code, signal) => { finish(code === 0 ? undefined : new Error(`Preparação da Nightly falhou: ${signal ?? code}.`)).catch(reject); });
  });
  const after = await inputSnapshot();
  if (after.key !== before.key || after.changes !== before.changes) throw new Error('Os fontes ou dependências mudaram durante a preparação. Abra novamente a Nightly.');
  const saved = { formatVersion: 1, inputKey: before.key, outputKey: await outputKey() };
  await writeFile(`${cachePath}.tmp`, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  await rename(`${cachePath}.tmp`, cachePath);
}

await prepare();
