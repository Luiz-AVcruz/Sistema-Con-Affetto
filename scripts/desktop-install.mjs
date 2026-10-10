import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quoteShell = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function optionalRead(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function selectedDatabase(override, configuration, launchScript) {
  if (override !== undefined && override !== null) {
    if (!override.trim()) throw new Error('CAIXA_DB não pode ser vazio.');
    return resolve(override);
  }
  if (configuration !== null) {
    const saved = JSON.parse(configuration);
    if (saved.formatVersion !== 1 || !(saved.database === null || typeof saved.database === 'string' && isAbsolute(saved.database))) {
      throw new Error('Configuração do banco inválida. A instalação anterior foi preservada.');
    }
    return saved.database;
  }
  const previousLaunch = await optionalRead(launchScript);
  if (!previousLaunch || !previousLaunch.includes('CAIXA_DB')) return null;
  // Reconhece somente o literal gerado por este instalador. Nunca executa o launcher.
  const literal = previousLaunch.match(/^export CAIXA_DB=(.+)$/m)?.[1];
  if (!literal || !/^'(?:[^']|'\\'')*'$/.test(literal)) {
    throw new Error('Não foi possível recuperar o banco do atalho anterior. Informe CAIXA_DB explicitamente.');
  }
  const database = literal.slice(1, -1).replaceAll("'\\''", "'");
  if (!isAbsolute(database)) throw new Error('O banco do atalho anterior tem caminho relativo. Informe CAIXA_DB com caminho absoluto.');
  return database;
}

export async function installDesktop({ root = projectRoot, installHome = homedir(), databaseOverride = process.env['CAIXA_DB'] } = {}) {
  const appRoot = join(root, 'apps/desktop');
  const buildRoot = join(appRoot, 'src-tauri/target/release');
  const executable = join(buildRoot, 'caixa-da-feira-desktop');
  const sourceResources = join(appRoot, 'src-tauri/resources');
  const installRoot = join(installHome, '.local/share/caixa-da-feira');
  const applications = join(installHome, '.local/share/applications');
  const icons = join(installHome, '.local/share/icons/hicolor/scalable/apps');
  const configurationPath = join(installHome, '.config/caixa-da-feira/database.json');
  const launchScript = join(installRoot, 'launch');
  const oldConfiguration = await optionalRead(configurationPath);
  const database = await selectedDatabase(databaseOverride, oldConfiguration, launchScript);

  async function requireFile(path) {
    try { if (!(await stat(path)).isFile()) throw new Error('Não é um arquivo'); }
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
  try {
    await cp(executable, join(staging, 'caixa-da-feira'));
    await chmod(join(staging, 'caixa-da-feira'), 0o755);
    await cp(sourceResources, join(staging, 'resources'), { recursive: true });
    await chmod(join(staging, 'resources/bin/node'), 0o755);

    const launchContents = [
      '#!/bin/sh',
      'set -eu',
      ...(database ? [`export CAIXA_DB=${quoteShell(database)}`] : []),
      `exec ${quoteShell(join(installRoot, 'caixa-da-feira'))} "$@"`,
      ''
    ].join('\n');
    await writeFile(join(staging, 'launch'), launchContents, { mode: 0o755 });
    await chmod(join(staging, 'launch'), 0o755);
    await mkdir(dirname(configurationPath), { recursive: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  let hadPrevious = false;
  let installed = false;
  try {
    try { await rename(installRoot, previous); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(staging, installRoot);
    installed = true;

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

    await writeFile(`${configurationPath}.tmp`, JSON.stringify({ formatVersion: 1, database }) + '\n', { mode: 0o600 });
    await rename(`${configurationPath}.tmp`, configurationPath);
  } catch (error) {
    if (installed) await rm(installRoot, { recursive: true, force: true });
    if (hadPrevious) await rename(previous, installRoot);
    await rm(staging, { recursive: true, force: true });
    await rm(`${configurationPath}.tmp`, { force: true });
    throw error;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
  return { installRoot, desktopPath: join(applications, 'caixa-da-feira.desktop'), database };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installDesktop();
  console.log(`Aplicativo instalado em ${result.installRoot}`);
  console.log(`Atalho criado em ${result.desktopPath}`);
  console.log(result.database
    ? `O atalho usará o banco configurado: ${result.database}`
    : 'O banco ficará na pasta de dados local do aplicativo, a menos que o atalho seja configurado com CAIXA_DB.');
}
