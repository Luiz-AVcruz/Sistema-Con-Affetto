import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const folder = mkdtempSync(join(tmpdir(), 'caixa-browser-'));
const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
  stdio: 'inherit', env: { ...process.env, PORT: '3334', CAIXA_DB: join(folder, 'browser.sqlite') }
});
child.on('exit', code => { rmSync(folder, { recursive: true, force: true }); process.exit(code ?? 0); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
