import { cp, chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/desktop');
const resourceRoot = resolve(process.env['CAIXA_DESKTOP_RESOURCES_DIR'] ?? join(app, 'src-tauri/resources'));
const nodeModules = join(root, 'node_modules');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com código ${result.status ?? 'desconhecido'}.`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// Rebuilds the same production frontend/API that the web app uses before copying them.
run('npm', ['run', 'build'], root);

const nodeSource = process.execPath;
const serverSource = join(root, 'apps/api/dist/server.js');
const frontendSource = join(root, 'apps/web/dist/browser');
const sqliteSource = join(nodeModules, 'better-sqlite3');
const bindingSource = join(nodeModules, 'bindings');
const fileUriSource = join(nodeModules, 'file-uri-to-path');
const addonSource = join(sqliteSource, 'build/Release/better_sqlite3.node');

for (const required of [nodeSource, serverSource, join(frontendSource, 'index.html'), addonSource]) {
  if (!await exists(required)) throw new Error(`Artefato necessário não encontrado: ${required}`);
}

await rm(resourceRoot, { recursive: true, force: true });
await mkdir(join(resourceRoot, 'bin'), { recursive: true });
await mkdir(join(resourceRoot, 'frontend'), { recursive: true });
await mkdir(join(resourceRoot, 'node_modules'), { recursive: true });

await copyFile(nodeSource, join(resourceRoot, 'bin/node'), constants.COPYFILE_FICLONE);
await chmod(join(resourceRoot, 'bin/node'), 0o755);
await cp(frontendSource, join(resourceRoot, 'frontend'), { recursive: true });

// Bundle the Node application while keeping the one native module external.
await build({
  entryPoints: [serverSource],
  outfile: join(resourceRoot, 'server.mjs'),
  bundle: true,
  packages: 'bundle',
  external: ['better-sqlite3'],
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  sourcemap: false,
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"
  }
});

for (const [source, target] of [
  [sqliteSource, join(resourceRoot, 'node_modules/better-sqlite3')],
  [bindingSource, join(resourceRoot, 'node_modules/bindings')],
  [fileUriSource, join(resourceRoot, 'node_modules/file-uri-to-path')]
]) {
  await cp(source, target, {
    recursive: true,
    filter: (path) => !/(?:^|\/)(?:test|tests|benchmark|benchmark\.js|\.github)(?:\/|$)/.test(path)
  });
}

// The application points to this page only if the Node service cannot start.
await copyFile(join(app, 'src-tauri/error.html'), join(resourceRoot, 'frontend/desktop-error.html'));

const nodeVersion = await readFile(join(nodeModules, 'better-sqlite3/package.json'), 'utf8').then(text => JSON.parse(text).version);
const manifest = {
  formatVersion: 1,
  nodeVersion: process.version,
  betterSqlite3Version: nodeVersion,
  nativeAddon: 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
};
await mkdir(resourceRoot, { recursive: true });
await writeFile(join(resourceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

console.log(`Recursos desktop preparados em ${resourceRoot}`);
console.log(`Node ${process.version}; better-sqlite3 ${nodeVersion}; ${process.arch}`);
