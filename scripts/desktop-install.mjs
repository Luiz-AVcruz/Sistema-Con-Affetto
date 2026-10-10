import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps/desktop');
const buildRoot = join(appRoot, 'src-tauri/target/release');
const executable = join(buildRoot, 'caixa-da-feira-desktop');
const sourceResources = join(appRoot, 'src-tauri/resources');
const installRoot = join(homedir(), '.local/share/caixa-da-feira');
const applications = join(homedir(), '.local/share/applications');
const icons = join(homedir(), '.local/share/icons/hicolor/scalable/apps');

async function requireFile(path) {
  try { await stat(path); }
  catch { throw new Error(`Arquivo de build não encontrado: ${path}. Execute npm run build -w @caixa/desktop antes da instalação.`); }
}

await requireFile(executable);
await requireFile(join(sourceResources, 'server.mjs'));
await requireFile(join(sourceResources, 'bin/node'));
await requireFile(join(sourceResources, 'frontend/index.html'));

const staging = `${installRoot}.installing-${process.pid}`;
const previous = `${installRoot}.previous-${process.pid}`;
await mkdir(dirname(installRoot), { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(executable, join(staging, 'caixa-da-feira'));
await chmod(join(staging, 'caixa-da-feira'), 0o755);
await cp(sourceResources, join(staging, 'resources'), { recursive: true });
await chmod(join(staging, 'resources/bin/node'), 0o755);

let hadPrevious = false;
try {
  try { await rename(installRoot, previous); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(staging, installRoot);
} catch (error) {
  if (hadPrevious) await rename(previous, installRoot).catch(() => {});
  await rm(staging, { recursive: true, force: true });
  throw error;
}
if (hadPrevious) await rm(previous, { recursive: true, force: true });

const launchScript = join(installRoot, 'launch');
const database = process.env['CAIXA_DB'];
const quoteShell = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const launchContents = [
  '#!/bin/sh',
  'set -eu',
  ...(database ? [`export CAIXA_DB=${quoteShell(database)}`] : []),
  `exec ${quoteShell(join(installRoot, 'caixa-da-feira'))} "$@"`,
  ''
].join('\n');
await writeFile(`${launchScript}.tmp`, launchContents, { mode: 0o755 });
await chmod(`${launchScript}.tmp`, 0o755);
await rename(`${launchScript}.tmp`, launchScript);

await mkdir(applications, { recursive: true });
await mkdir(icons, { recursive: true });
await cp(join(appRoot, 'icons/caixa-da-feira.svg'), join(icons, 'caixa-da-feira.svg'));
const desktopFile = [
  '[Desktop Entry]',
  'Type=Application',
  'Name=Caixa da Feira',
  'Comment=Controle local de vendas e fechamento da feira',
  `Exec=${launchScript}`,
  'Icon=caixa-da-feira',
  'Terminal=false',
  'StartupNotify=true',
  'StartupWMClass=caixa-da-feira',
  'Categories=Office;Utility;',
  ''
].join('\n');
const desktopPath = join(applications, 'caixa-da-feira.desktop');
await writeFile(`${desktopPath}.tmp`, desktopFile, { mode: 0o644 });
await rename(`${desktopPath}.tmp`, desktopPath);

console.log(`Aplicativo instalado em ${installRoot}`);
console.log(`Atalho criado em ${desktopPath}`);
console.log(database
  ? `O atalho usará o banco indicado em CAIXA_DB: ${database}`
  : 'O banco ficará na pasta de dados local do aplicativo, a menos que o atalho seja configurado com CAIXA_DB.');
