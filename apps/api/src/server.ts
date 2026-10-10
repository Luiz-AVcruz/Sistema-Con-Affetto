import { createApp } from './app.js';
import { CashRegister } from './cash-register.js';
import { openDatabase } from './database.js';
import { databasePath, frontendPath } from './paths.js';

const port = Number(process.env['PORT'] ?? 3333);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT precisa ser uma porta entre 1024 e 65535.');
const db = openDatabase(databasePath);
const server = createApp(new CashRegister(db), frontendPath).listen(port, '127.0.0.1', () => {
  console.log(`Caixa da feira: http://127.0.0.1:${port}`);
  console.log(`Banco local: ${databasePath}`);
});
server.on('error', error => { console.error(error.message); db.close(); process.exitCode = 1; });
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
