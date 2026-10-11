import { chmod, cp, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const database = resolve(process.env.CAIXA_DB ?? join(root, 'data/nightly/caixa.sqlite'));
if (!(await stat(database)).isFile()) throw new Error('Restaure o banco da Nightly antes de instalar o atalho.');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const installRoot = join(homedir(), '.local/share/caixa-da-feira-nightly');
const applications = join(homedir(), '.local/share/applications');
const icons = join(homedir(), '.local/share/icons/hicolor/scalable/apps');
for (const folder of [installRoot, applications, icons]) await mkdir(folder, { recursive: true });
const launch = join(installRoot, 'launch');
await writeFile(`${launch}.tmp`, [
  '#!/bin/sh',
  `exec /bin/bash ${quote(join(root, 'scripts/nightly-launch.sh'))} ${quote(root)} ${quote(database)}`,
  ''
].join('\n'), { mode: 0o755 });
await chmod(`${launch}.tmp`, 0o755);
await rename(`${launch}.tmp`, launch);
await cp(join(root, 'apps/desktop/icons/caixa-da-feira.svg'), join(icons, 'caixa-da-feira-nightly.svg'));
const desktop = join(applications, 'caixa-da-feira-nightly.desktop');
// Exec segue o escape de argumentos do Desktop Entry, sem execução de shell.
const desktopQuote = value => '"' + value.replace(/[\\"`$]/g, match => '\\' + match).replaceAll('%', '%%') + '"';
await writeFile(`${desktop}.tmp`, [
  '[Desktop Entry]', 'Type=Application', 'Name=Caixa da Feira — Nightly',
  'Comment=Versão local atual do projeto, com banco separado do Flatpak',
  `Exec=${desktopQuote(launch)}`, 'Icon=caixa-da-feira-nightly',
  'Terminal=false', 'StartupNotify=true', 'StartupWMClass=caixa-da-feira',
  'Categories=Office;', ''
].join('\n'), { mode: 0o644 });
await rename(`${desktop}.tmp`, desktop);
console.log(`Atalho: ${desktop}\nBanco: ${database}\nFontes: ${root}`);
