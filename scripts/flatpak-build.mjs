import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const applicationId = 'br.com.caixadafeira.local';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com código ${result.status ?? 'desconhecido'}.`);
}

// Só código e arquivos de build. Nem mesmo um banco rastreado por engano é copiado.
export function prepareFlatpakSources(root, destination) {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error('O build precisa do repositório Git local para selecionar os fontes.');
  const selected = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path =>
    (/^(apps|packages|scripts|packaging)\//.test(path) || path.startsWith('tests/packaging/') || ['package.json', 'package-lock.json', 'LICENSE'].includes(path))
    && !/(?:^|\/)(?:data|node_modules|target|dist|resources|\.git|\.angular)(?:\/|$)/.test(path)
    && !/(?:\.(?:sqlite3?|db)(?:[-.].*)?|\.ods(?:\..*)?|\.env(?:\..*)?|-planilha\.json)$/i.test(path)
  );
  for (const path of selected) {
    const source = join(root, path);
    let cursor = root;
    let missing = false;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      let stat;
      try { stat = lstatSync(cursor); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing = true;
        break;
      }
      if (stat.isSymbolicLink()) throw new Error(`Fonte simbólico não permitido no pacote: ${path}`);
    }
    if (missing) continue;
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
  return selected;
}

export function buildFlatpak(root = projectRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Este pacote é para Linux x86_64.');
  const output = join(root, 'dist/flatpak');
  const sources = join(output, 'source');
  mkdirSync(output, { recursive: true });
  rmSync(sources, { recursive: true, force: true });
  prepareFlatpakSources(root, sources);
  const manifest = join(root, 'packaging/flatpak', `${applicationId}.json`);
  const buildDirectory = join(output, 'build');
  const repository = join(output, 'repo');
  const nativeBuilder = spawnSync('flatpak-builder', ['--version'], { stdio: 'ignore' });
  const command = nativeBuilder.status === 0 ? 'flatpak-builder' : 'flatpak';
  const args = command === 'flatpak' ? ['run', 'org.flatpak.Builder'] : [];
  run(command, [...args, '--user', '--install-deps-from=flathub', '--force-clean',
    '--disable-rofiles-fuse', '--rebuild-on-sdk-change', '--jobs=2',
    `--state-dir=${join(output, 'state')}`, `--repo=${repository}`, buildDirectory, manifest], root);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const bundle = join(output, `caixa-da-feira-${version}-x86_64.flatpak`);
  run('flatpak', ['build-bundle', repository, bundle, applicationId, 'stable',
    '--runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo'], root);
  const checksum = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  writeFileSync(`${bundle}.sha256`, `${checksum}  ${relative(output, bundle)}\n`);
  console.log(`Pacote: ${bundle}\nSHA-256: ${checksum}`);
  console.log('O pacote não contém o banco do comércio. Instale-o e restaure um backup separadamente.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildFlatpak(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
