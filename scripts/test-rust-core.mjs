import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = 'packages/caixa-core/Cargo.toml';
const localCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = process.env.CARGO ?? (existsSync(localCargo) ? localCargo : 'cargo');
const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' };

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} terminou com código ${result.status ?? 'desconhecido'}.`);
}

run(cargo, ['fmt', '--manifest-path', manifest, '--', '--check']);
run(cargo, ['test', '--locked', '--offline', '--manifest-path', manifest]);
run(cargo, ['build', '--locked', '--offline', '--manifest-path', manifest]);
// Cargo informa a pasta de artefatos; CARGO_TARGET_DIR ou config local não devem
// fazer o teste executar um binário antigo de outra pasta.
const metadata = spawnSync(cargo, ['metadata', '--format-version', '1', '--no-deps', '--locked', '--offline', '--manifest-path', manifest],
  { cwd: root, env, encoding: 'utf8' });
if (metadata.error) throw metadata.error;
if (metadata.status !== 0) throw new Error(metadata.stderr);
const binary = join(JSON.parse(metadata.stdout).target_directory, 'debug', process.platform === 'win32' ? 'caixa-core.exe' : 'caixa-core');
run(process.execPath, ['--import', 'tsx', '--test', 'tests/rust-core/parity.test.ts'], { CAIXA_RUST_CORE_BINARY: binary });
