import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareFlatpakSources } from '../../scripts/flatpak-build.mjs';

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'caixa-flatpak '));
  const root = join(folder, 'projeto com espaços'), destination = join(folder, 'fontes');
  mkdirSync(root);
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--quiet']);
  const put = (path, contents) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); };
  return { folder, root, destination, git, put };
}

test('snapshot usa código atual e exclui dados reais, segredos e artefatos mesmo se rastreados', () => {
  const f = fixture();
  try {
    f.put('.gitignore', 'node_modules/\n');
    f.put('package.json', '{"version":"0.1.0"}');
    f.put('apps/api/src/server.ts', 'código anterior');
    f.put('data/caixa.sqlite', 'banco privado');
    f.put('apps/api/test/acidental.sqlite', 'banco rastreado por engano');
    f.put('apps/api/test/acidental.sqlite3', 'outro banco rastreado');
    f.put('apps/api/test/acidental.db-wal', 'auxiliar de banco rastreado');
    f.put('apps/api/test/referencia.ods.old', 'planilha antiga');
    f.put('apps/api/src/.env', 'segredo rastreado por engano');
    f.put('apps/desktop/src-tauri/resources/privado.json', 'recurso antigo');
    f.put('apps/web/dist/index.html', 'build antigo');
    f.git(['add', '.']);
    f.put('apps/api/src/server.ts', 'código atual ainda não commitado');
    f.put('packaging/flatpak/novo.json', '{}');
    f.put('node_modules/segredo.json', 'dependência local');
    const selected = prepareFlatpakSources(f.root, f.destination);
    assert.deepEqual(selected.sort(), ['apps/api/src/server.ts', 'package.json', 'packaging/flatpak/novo.json']);
    assert.equal(readFileSync(join(f.destination, 'apps/api/src/server.ts'), 'utf8'), 'código atual ainda não commitado');
    assert.equal(readFileSync(join(f.root, 'data/caixa.sqlite'), 'utf8'), 'banco privado');
  } finally { rmSync(f.folder, { recursive: true, force: true }); }
});

test('snapshot recusa link simbólico para arquivo externo em vez de incluir seu conteúdo', () => {
  const f = fixture();
  try {
    f.put('package.json', '{}');
    f.put('apps/api/src/.keep', '');
    writeFileSync(join(f.folder, 'privado.txt'), 'privado');
    symlinkSync(join(f.folder, 'privado.txt'), join(f.root, 'apps/api/src/external.ts'));
    assert.throws(() => prepareFlatpakSources(f.root, f.destination), /simbólico/);
    assert.equal(readFileSync(join(f.folder, 'privado.txt'), 'utf8'), 'privado');
  } finally { rmSync(f.folder, { recursive: true, force: true }); }
});

test('snapshot recusa diretório simbólico substituindo fontes rastreados', () => {
  const f = fixture();
  try {
    f.put('apps/api/src/server.ts', 'código anterior');
    f.git(['add', '.']);
    const external = join(f.folder, 'externo');
    mkdirSync(external);
    writeFileSync(join(external, 'server.ts'), 'conteúdo privado fora do projeto');
    rmSync(join(f.root, 'apps/api/src'), { recursive: true });
    symlinkSync(external, join(f.root, 'apps/api/src'));
    assert.throws(() => prepareFlatpakSources(f.root, f.destination), /simbólico/);
    assert.equal(readFileSync(join(external, 'server.ts'), 'utf8'), 'conteúdo privado fora do projeto');
  } finally { rmSync(f.folder, { recursive: true, force: true }); }
});

test('snapshot recusa link simbólico cujo destino está ausente', () => {
  const f = fixture();
  try {
    f.put('apps/api/src/.keep', '');
    symlinkSync(join(f.folder, 'ausente.ts'), join(f.root, 'apps/api/src/external.ts'));
    assert.throws(() => prepareFlatpakSources(f.root, f.destination), /simbólico/);
  } finally { rmSync(f.folder, { recursive: true, force: true }); }
});
