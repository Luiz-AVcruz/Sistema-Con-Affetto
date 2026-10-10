import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openDatabase } from '../apps/api/dist/database.js';
import { CashRegister } from '../apps/api/dist/cash-register.js';
import { importHistory } from '../apps/api/dist/historical-import.js';

const folder = mkdtempSync(join(tmpdir(), 'caixa-browser-'));
const databasePath = join(folder, 'browser.sqlite');
// Fixture isolada: uma venda e um fechamento anteriores, com horário desconhecido.
const db = openDatabase(databasePath);
try {
  db.prepare('INSERT INTO owners(id,name) VALUES(1,?)').run('Participante histórico');
  new CashRegister(db).saveProduct({ name: 'Produto histórico', description: '', ownerId: 1, priceCents: 2500, stock: 0, active: true });
  const expected = { receivedCents: 2500, netCents: 2500, discountCents: 0, feeCents: 0, pendingCents: 0, barterUnits: 0, giftUnits: 0,
    byOwner: { 'Participante histórico': 2500 }, byPayment: { 'Dinheiro': 2500, 'Pix': 0, 'Cartão débito': 0, 'Cartão crédito': 0 } };
  importHistory(db, { formatVersion: 1, sourceKey: 'caixa-da-feira-ods', source: 'fixture.ods', sha256: 'a'.repeat(64), lockPresent: false,
    products: [{ name: 'Produto histórico', stock: 0 }], rows: [{ rowNumber: 6, orderRef: '', date: '2026-10-08', paymentMethod: 'Dinheiro',
      status: 'Pago', note: 'Pedido histórico de teste', name: 'Produto histórico', ownerName: 'Participante histórico', quantity: 1,
      priceCents: 2500, discountCents: 0, feeCents: 0, totalCents: 2500, netCents: 2500 }], expected,
    closedDays: [{ date: '2026-10-08', cash: { openingCents: 0, extraCents: 0, withdrawalCents: 0, countedCents: null, note: '' }, expected,
      expectedCents: null, differenceCents: null }] });
} finally { db.close(); }
const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
  stdio: 'inherit', env: { ...process.env, PORT: '3334', CAIXA_DB: databasePath }
});
child.on('exit', code => { rmSync(folder, { recursive: true, force: true }); process.exit(code ?? 0); });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
