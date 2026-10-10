import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { openDatabase } from './database.js';
import { CashRegister } from './cash-register.js';
import { databasePath, projectRoot } from './paths.js';
import { productSchema } from './validation.js';

const path = process.argv[2] ?? resolve(projectRoot, 'data/catalogo-planilha.json');
const input = z.object({ products: z.array(productSchema.omit({ ownerId: true }).extend({ ownerName: z.string().trim().min(1).max(100) })).min(1) }).passthrough().parse(JSON.parse(readFileSync(path, 'utf8')));
const db = openDatabase(databasePath);
try {
  const register = new CashRegister(db);
  db.transaction(() => {
    if ((db.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number }).count > 0) throw new Error('O cadastro já tem produtos. Nada foi sobrescrito.');
    for (const product of input.products) {
      db.prepare('INSERT INTO owners(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(product.ownerName);
      const owner = register.owners().find(owner => owner.name === product.ownerName)!;
      const { ownerName, ...fields } = product;
      register.saveProduct({ ...fields, ownerId: owner.id });
    }
  })();
  console.log(`${input.products.length} produtos importados. Para trazer pedidos e fechamentos, execute npm run import:history na raiz do projeto.`);
} finally { db.close(); }
