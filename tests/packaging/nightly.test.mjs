import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const builder = String.raw`
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = process.cwd(), data = join(root, 'data');
const count = join(data, 'builds');
writeFileSync(count, String((existsSync(count) ? Number(readFileSync(count)) : 0) + 1));
if (existsSync(join(data, 'fail'))) process.exit(9);
if (existsSync(join(data, 'block'))) {
  const writer = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => require("node:fs").appendFileSync(process.argv[1], "x"), 10)', join(data, 'ticks')], { stdio: 'inherit' });
  writeFileSync(join(data, 'writer-pid'), String(writer.pid));
  writeFileSync(join(data, 'supervisor-pid'), String(process.ppid));
  await new Promise(() => setInterval(() => {}, 1000));
}
const source = join(root, 'apps/api/src/server.ts'), original = readFileSync(source), info = statSync(source);
const change = existsSync(join(data, 'change')), restore = existsSync(join(data, 'restore'));
if (change || restore) writeFileSync(source, 'BBBB');
const output = process.env.CAIXA_DESKTOP_RESOURCES_DIR;
rmSync(output, { recursive: true, force: true });
const put = (path, contents) => { const full = join(output, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, contents); };
put('bin/node', 'node de teste'); chmodSync(join(output, 'bin/node'), 0o755);
put('server.mjs', readFileSync(source));
put('frontend/index.html', '<script src="main.js"></script>');
put('frontend/main.js', 'interface compilada');
put('frontend/desktop-error.html', 'erro');
put('manifest.json', '{"formatVersion":1}');
put('node_modules/better-sqlite3/package.json', '{"version":"13.0.3"}');
put('node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'addon de teste');
if (restore) { writeFileSync(source, original); utimesSync(source, info.atime, info.mtime); }
`;

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-nightly ')), root = join(folder, 'projeto com espaços');
  const resources = join(root, 'apps/desktop/src-tauri/resources');
  const put = (path, contents, mode) => {
    const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, contents);
    if (mode) chmodSync(full, mode);
  };
  put('package.json', '{}'); put('package-lock.json', '{}');
  put('apps/api/src/server.ts', 'AAAA'); put('apps/web/src/main.ts', 'frontend');
  put('apps/web/angular.json', '{}'); put('apps/web/package.json', '{}');
  put('packages/shared/src/index.ts', 'shared'); put('apps/desktop/package.json', '{}');
  put('apps/desktop/src-tauri/error.html', 'erro'); put('apps/desktop/src-tauri/Cargo.toml', 'rust');
  put('node_modules/.package-lock.json', '{}');
  put('node_modules/better-sqlite3/package.json', '{"version":"13.0.3"}');
  put('node_modules/better-sqlite3/lib/index.js', 'loader');
  put('node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'addon');
  put('scripts/desktop-prepare.mjs', builder); put('data/caixa.sqlite', 'banco de teste');
  copyFileSync(join(repository, 'scripts/nightly-prepare.mjs'), join(root, 'scripts/nightly-prepare.mjs'));
  const env = { ...process.env, CAIXA_DESKTOP_RESOURCES_DIR: resources };
  for (const name of Object.keys(env)) if (/^(?:BROWSERSLIST|NG_BUILD_|NODE_OPTIONS$|NODE_ENV$)/.test(name)) delete env[name];
  const run = (extra = {}, runtime = process.execPath) => spawnSync(runtime, [join(root, 'scripts/nightly-prepare.mjs')], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
  const builds = () => existsSync(join(root, 'data/builds')) ? Number(readFileSync(join(root, 'data/builds'))) : 0;
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, root, resources, put, env, run, builds };
}

function success(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }
function reused(f, extra) { const previous = f.builds(); const result = f.run(extra); success(result); assert.match(result.stdout, /reutilizando/); assert.equal(f.builds(), previous); }
function rebuilt(f, extra, runtime) { const previous = f.builds(); const result = f.run(extra, runtime); success(result); assert.match(result.stdout, /preparando/); assert.equal(f.builds(), previous + 1); }

test('cache reutiliza artefatos sem reescrita e invalida fontes/configuração/dependências por conteúdo', t => {
  const f = fixture(t);
  rebuilt(f);
  const artifact = join(f.resources, 'server.mjs'), modified = statSync(artifact).mtimeMs;
  reused(f); assert.equal(statSync(artifact).mtimeMs, modified);
  const source = join(f.root, 'apps/api/src/server.ts'), info = statSync(source);
  writeFileSync(source, 'CCCC'); utimesSync(source, info.atime, info.mtime);
  rebuilt(f); assert.equal(readFileSync(artifact, 'utf8'), 'CCCC');
  for (const [path, value] of [
    ['apps/web/src/main.ts', 'frontend novo'], ['packages/shared/src/index.ts', 'contrato novo'],
    ['apps/web/angular.json', '{"novo":true}'], ['package-lock.json', '{"instalação":2}'],
    ['.npmrc', 'fund=false'], ['apps/desktop/src-tauri/error.html', 'erro novo'],
    ['node_modules/better-sqlite3/lib/index.js', 'loader novo'],
    ['node_modules/better-sqlite3/build/Release/better_sqlite3.node', 'addon novo']
  ]) { f.put(path, value); rebuilt(f); }
  f.put('apps/web/src/novo.ts', 'novo'); rebuilt(f);
  rmSync(join(f.root, 'apps/web/src/novo.ts')); rebuilt(f);
  const installed = join(f.root, 'node_modules/.package-lock.json'), installedInfo = statSync(installed);
  utimesSync(installed, installedInfo.atime, new Date(installedInfo.mtimeMs + 1000));
  rebuilt(f); reused(f);
});

test('dados, perfil, documentação e saídas de compilação não exigem rebuild', t => {
  const f = fixture(t); rebuilt(f);
  for (const path of ['data/caixa.sqlite', 'docs/guia.md', '.env', 'apps/api/dist/server.js', 'apps/web/.angular/cache', 'packages/shared/dist/index.js', 'apps/web/.git/arquivo']) f.put(path, 'alterado');
  reused(f);
});

test('recursos ausentes, corrompidos ou sem permissão e marcador inválido são reconstruídos', t => {
  const f = fixture(t); rebuilt(f);
  rmSync(join(f.resources, 'frontend/main.js')); rebuilt(f);
  const executable = join(f.resources, 'bin/node'), info = statSync(executable);
  writeFileSync(executable, 'node danifica'); utimesSync(executable, info.atime, info.mtime); rebuilt(f);
  chmodSync(executable, 0o644); rebuilt(f); assert.equal(statSync(executable).mode & 0o777, 0o755);
  writeFileSync(join(f.resources, 'frontend/extra.js'), 'intruso'); rebuilt(f);
  writeFileSync(join(f.resources, '.nightly-cache.json'), '{incompleto'); rebuilt(f);
  rmSync(join(f.resources, 'manifest.json')); rebuilt(f); reused(f);
});

test('runtime de outro caminho exige preparo e depois permite reutilização', t => {
  const f = fixture(t); rebuilt(f);
  const runtime = join(f.folder, 'node alternativo'); copyFileSync(process.execPath, runtime); chmodSync(runtime, 0o755);
  rebuilt(f, {}, runtime);
  const result = f.run({}, runtime); success(result); assert.match(result.stdout, /reutilizando/);
});

test('falha de build e mudanças persistentes ou temporárias A→B→A não registram cache', t => {
  const f = fixture(t), marker = join(f.resources, '.nightly-cache.json'); rebuilt(f);
  f.put('apps/api/src/server.ts', 'CCCC'); f.put('data/fail', '');
  assert.notEqual(f.run().status, 0); assert.equal(existsSync(marker), false);
  rmSync(join(f.root, 'data/fail')); rebuilt(f);
  for (const flag of ['change', 'restore']) {
    f.put('apps/api/src/server.ts', 'AAAA'); f.put(`data/${flag}`, '');
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /mudaram durante/);
    assert.equal(existsSync(marker), false);
    if (flag === 'restore') assert.equal(readFileSync(join(f.root, 'apps/api/src/server.ts'), 'utf8'), 'AAAA');
    rmSync(join(f.root, `data/${flag}`)); rebuilt(f); reused(f);
  }
});

test('invalida configuração efetivamente consumida pelo Browserslist do Angular', t => {
  const f = fixture(t);
  const targets = extra => {
    const code = `const {getSupportedBrowsers}=require(${JSON.stringify(join(repository, 'node_modules/@angular/build/src/utils/supported-browsers.js'))}); console.log(JSON.stringify(getSupportedBrowsers(${JSON.stringify(join(f.root, 'apps/web'))},{warn(){}})));`;
    const result = spawnSync(process.execPath, ['-e', code], { cwd: join(f.root, 'apps/web'), env: { ...f.env, ...extra }, encoding: 'utf8' });
    success(result); return JSON.parse(result.stdout);
  };
  const defaults = targets({}); rebuilt(f);
  const inline = { BROWSERSLIST: 'safari 15' };
  assert.deepEqual(targets(inline), ['safari 15']); assert.notDeepEqual(defaults, targets(inline));
  rebuilt(f, inline); reused(f, inline); rebuilt(f);
  // Arquivo fora do workspace web e fora do próprio repositório.
  const ancestor = join(f.folder, '.browserslistrc'); writeFileSync(ancestor, 'safari 15');
  assert.deepEqual(targets({}), ['safari 15']); rebuilt(f);
  writeFileSync(ancestor, '[production]\nsafari 15\n[development]\nsafari 16');
  rebuilt(f); assert.deepEqual(targets({ BROWSERSLIST_ENV: 'development' }), ['safari 16.0']);
  rebuilt(f, { BROWSERSLIST_ENV: 'development' }); rmSync(ancestor);
  const explicit = join(f.folder, 'alvos.txt'); writeFileSync(explicit, 'safari 15');
  const config = { BROWSERSLIST_CONFIG: explicit };
  assert.deepEqual(targets(config), ['safari 15']); rebuilt(f, config);
  writeFileSync(explicit, 'safari 16'); assert.deepEqual(targets(config), ['safari 16.0']); rebuilt(f, config);
  const relativeConfig = { BROWSERSLIST_CONFIG: relative(join(f.root, 'apps/web'), explicit) };
  assert.deepEqual(targets(relativeConfig), ['safari 16.0']); rebuilt(f, relativeConfig);
  writeFileSync(explicit, 'safari 15'); assert.deepEqual(targets(relativeConfig), ['safari 15']); rebuilt(f, relativeConfig);
  rebuilt(f, { ...config, NG_BUILD_MANGLE: 'false' }); reused(f, { ...config, NG_BUILD_MANGLE: 'false' });
});

function launcherFixture(t) {
  const f = fixture(t);
  copyFileSync(join(repository, 'scripts/nightly-launch.sh'), join(f.root, 'scripts/nightly-launch.sh'));
  f.put('test-bin/gdbus', '#!/bin/bash\nif [[ -f data/owner ]]; then echo "(true,)"; else echo "(false,)"; fi\n', 0o755);
  f.put('test-bin/zenity', '#!/bin/bash\nprintf "%s\\n" "$*" >> data/messages\n', 0o755);
  f.put('test-bin/rustc', '#!/bin/bash\necho "rustc fixture"\n', 0o755);
  f.put('test-bin/cargo', String.raw`#!/bin/bash
count=0; [[ ! -f data/native-builds ]] || count=$(cat data/native-builds)
echo $((count + 1)) > data/native-builds
mkdir -p apps/desktop/src-tauri/target/release
cat > apps/desktop/src-tauri/target/release/caixa-da-feira-desktop <<'NATIVE'
#!/bin/bash
echo "$CAIXA_DB" > data/started
while [[ -f data/hold ]]; do sleep .02; done
NATIVE
chmod +x apps/desktop/src-tauri/target/release/caixa-da-feira-desktop
`, 0o755);
  const env = { ...f.env, HOME: join(f.root, 'home'), XDG_STATE_HOME: join(f.root, 'state'), PATH: join(f.root, 'test-bin') + ':' + process.env.PATH };
  const args = [join(f.root, 'scripts/nightly-launch.sh'), f.root, join(f.root, 'data/caixa.sqlite'), process.execPath];
  const launch = database => spawnSync('/bin/bash', database ? [args[0], f.root, database, process.execPath] : args, { cwd: f.root, env, encoding: 'utf8' });
  const start = () => spawn('/bin/bash', args, { cwd: f.root, env, stdio: 'ignore' });
  return { ...f, launch, start };
}

async function until(condition) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) assert.fail('Condição de runtime não chegou em 10 segundos'); await delay(20); }
}
function exited(child) { return new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); }); }

test('launcher mantém trava, cache e bloqueio de outra variante; recusa banco inexistente', async t => {
  const f = launcherFixture(t); f.put('data/hold', '');
  const first = f.start(), completion = exited(first);
  try {
    await until(() => existsSync(join(f.root, 'data/started')));
    success(f.launch()); assert.equal(f.builds(), 1);
    assert.match(readFileSync(join(f.root, 'data/messages'), 'utf8'), /já está aberta/);
    rmSync(join(f.root, 'data/hold')); assert.equal((await completion).code, 0);
    success(f.launch()); assert.equal(f.builds(), 1); assert.equal(readFileSync(join(f.root, 'data/native-builds'), 'utf8').trim(), '1');
    assert.equal(readFileSync(join(f.root, 'data/started'), 'utf8').trim(), join(f.root, 'data/caixa.sqlite'));
    f.put('data/owner', ''); f.put('apps/api/src/server.ts', 'CCCC');
    success(f.launch()); assert.equal(f.builds(), 1);
    assert.match(readFileSync(join(f.root, 'data/messages'), 'utf8'), /outra janela/);
    assert.notEqual(f.launch(join(f.root, 'data/ausente.sqlite')).status, 0);
    assert.equal(existsSync(join(f.root, 'data/ausente.sqlite')), false); assert.equal(f.builds(), 1);
  } finally { rmSync(join(f.root, 'data/hold'), { force: true }); if (first.exitCode === null) first.kill('SIGTERM'); await completion; }
});

test('interrupção do supervisor encerra escritor descendente antes de liberar a trava', async t => {
  const f = launcherFixture(t); f.put('data/block', '');
  const launch = f.start(), completion = exited(launch);
  let supervisor;
  try {
    await until(() => existsSync(join(f.root, 'data/ticks')));
    supervisor = Number(readFileSync(join(f.root, 'data/supervisor-pid')));
    process.kill(supervisor, 'SIGTERM'); assert.notEqual((await completion).code, 0);
    const writer = Number(readFileSync(join(f.root, 'data/writer-pid')));
    if (existsSync(`/proc/${writer}/stat`)) {
      const record = readFileSync(`/proc/${writer}/stat`, 'utf8');
      assert.match(record.slice(record.lastIndexOf(')') + 2), /^[ZX] /, 'Escritor ainda executável ao liberar a trava');
    }
    assert.equal(existsSync(join(f.resources, '.nightly-cache.json')), false);
    const ticks = readFileSync(join(f.root, 'data/ticks'), 'utf8');
    await delay(150); assert.equal(readFileSync(join(f.root, 'data/ticks'), 'utf8'), ticks);
    rmSync(join(f.root, 'data/block')); success(f.launch()); assert.equal(f.builds(), 2);
    assert.equal(readFileSync(join(f.root, 'data/ticks'), 'utf8'), ticks);
  } finally {
    if (launch.exitCode === null) { if (supervisor) { try { process.kill(supervisor, 'SIGTERM'); } catch {} } else launch.kill('SIGTERM'); }
    await completion;
  }
});
