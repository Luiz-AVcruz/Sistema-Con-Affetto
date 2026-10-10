import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { installDesktop } from '../../../scripts/desktop-install.mjs';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'caixa-install-'));
  const root = join(folder, 'projeto'), installHome = join(folder, 'conta');
  const app = join(root, 'apps/desktop'), resources = join(app, 'src-tauri/resources');
  await mkdir(join(app, 'src-tauri/target/release'), { recursive: true });
  await mkdir(join(resources, 'bin'), { recursive: true });
  await mkdir(join(resources, 'frontend'), { recursive: true });
  await mkdir(join(app, 'icons'), { recursive: true });
  await writeFile(join(app, 'src-tauri/target/release/caixa-da-feira-desktop'), '#!/bin/sh\nprintf "%s" "${CAIXA_DB-unset}"\n');
  await writeFile(join(resources, 'bin/node'), 'runtime fictício');
  await writeFile(join(resources, 'server.mjs'), 'servidor fictício');
  await writeFile(join(resources, 'frontend/index.html'), '<html>fixture</html>');
  await writeFile(join(app, 'icons/caixa-da-feira.svg'), '<svg/>');
  return { folder, root, installHome, resources,
    configuration: join(installHome, '.config/caixa-da-feira/database.json'),
    launch: join(installHome, '.local/share/caixa-da-feira/launch') };
}

test('reinstalar sem CAIXA_DB preserva configuração e literal do caminho; banco não é modificado', async () => {
  const f = await fixture();
  try {
    const database = join(f.folder, "caixa ' $ ` literal.sqlite");
    await writeFile(database, 'dados que precisam ser preservados');
    await installDesktop({ ...f, databaseOverride: database });
    const original = await readFile(f.launch);
    assert.equal((await stat(f.configuration)).mode & 0o777, 0o600);
    await installDesktop({ ...f, databaseOverride: null });
    assert.deepEqual(await readFile(f.launch), original);
    assert.equal(JSON.parse(await readFile(f.configuration, 'utf8')).database, database);
    const run = spawnSync(f.launch, [], { encoding: 'utf8', env: { ...process.env, CAIXA_DB: undefined } });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, database);
    assert.equal(await readFile(database, 'utf8'), 'dados que precisam ser preservados');
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test('instalação antiga migra banco do launcher conhecido sem executar seu conteúdo', async () => {
  const f = await fixture();
  try {
    const database = join(f.folder, "caixa ' literal.sqlite");
    await installDesktop({ ...f, databaseOverride: database });
    await rm(f.configuration);
    await writeFile(f.launch, (await readFile(f.launch, 'utf8')) + '\nexit 91\n');
    const result = await installDesktop({ ...f, databaseOverride: null });
    assert.equal(result.database, database);
    assert.equal(JSON.parse(await readFile(f.configuration, 'utf8')).database, database);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test('configuração ilegível ou launcher ambíguo recusam atualização sem perder instalação anterior', async () => {
  const f = await fixture();
  try {
    await installDesktop({ ...f, databaseOverride: join(f.folder, 'original.sqlite') });
    const launch = await readFile(f.launch);
    await writeFile(f.configuration, '{invalido');
    await assert.rejects(installDesktop({ ...f, databaseOverride: null }));
    assert.deepEqual(await readFile(f.launch), launch);
    await rm(f.configuration);
    await writeFile(f.launch, '#!/bin/sh\nexport CAIXA_DB="$OUTRO_CAMINHO"\n');
    const custom = await readFile(f.launch);
    await assert.rejects(installDesktop({ ...f, databaseOverride: null }), /recuperar o banco/);
    assert.deepEqual(await readFile(f.launch), custom);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test('build incompleto ou falha após troca restauram instalação e configuração anteriores', async () => {
  const f = await fixture();
  try {
    await installDesktop({ ...f, databaseOverride: join(f.folder, 'original.sqlite') });
    const launch = await readFile(f.launch), configuration = await readFile(f.configuration);
    await rm(join(f.resources, 'server.mjs'));
    await assert.rejects(installDesktop({ ...f, databaseOverride: join(f.folder, 'novo.sqlite') }), /build não encontrado/);
    assert.deepEqual(await readFile(f.launch), launch); assert.deepEqual(await readFile(f.configuration), configuration);
    await writeFile(join(f.resources, 'server.mjs'), 'nova compilação');
    const applications = join(f.installHome, '.local/share/applications');
    await rm(applications, { recursive: true }); await writeFile(applications, 'impede criação da pasta');
    await assert.rejects(installDesktop({ ...f, databaseOverride: join(f.folder, 'novo.sqlite') }));
    assert.deepEqual(await readFile(f.launch), launch); assert.deepEqual(await readFile(f.configuration), configuration);
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

test('primeira instalação padrão permanece padrão; override explícito muda somente a configuração', async () => {
  const f = await fixture();
  try {
    const first = await installDesktop({ ...f, databaseOverride: null }); assert.equal(first.database, null);
    const repeated = await installDesktop({ ...f, databaseOverride: null }); assert.equal(repeated.database, null);
    assert.equal(spawnSync(f.launch, [], { encoding: 'utf8', env: { ...process.env, CAIXA_DB: undefined } }).stdout, 'unset');
    const changed = await installDesktop({ ...f, databaseOverride: join(f.folder, 'outro.sqlite') });
    assert.equal(changed.database, join(f.folder, 'outro.sqlite'));
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});
