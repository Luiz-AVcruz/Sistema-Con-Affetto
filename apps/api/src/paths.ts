import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const databasePath = process.env['CAIXA_DB'] ?? resolve(projectRoot, 'data/caixa.sqlite');
export const frontendPath = process.env['CAIXA_FRONTEND'] ?? resolve(projectRoot, 'apps/web/dist/browser');
