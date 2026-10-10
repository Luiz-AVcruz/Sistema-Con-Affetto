import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Owner, Product, ProductInput, SaleInput, Sale, SaleItem, Summary, Day, CashInput, Bootstrap, PaymentMethod, Fair, FairInput } from '@caixa/shared';
import { calculateItem, isNonCash, summarize } from './finance.js';
import { requireCondition } from './validation.js';

type SaleRow = { id: string; fair_id: number; request_hash: string; date: string; payment_date: string | null; payment_method: PaymentMethod; status: Sale['status']; note: string; created_at: string; origin: Sale['origin'] };
type DayRow = { date: string; opening_cents: number; extra_cents: number; withdrawal_cents: number; counted_cents: number | null; note: string; closed_at: string | null; snapshot: string | null };
type FairRow = { id: number; name: string; target_cents: number | null; start_date: string; end_date: string | null; created_at: string; closed_at: string | null; snapshot: string | null };

export class CashRegister {
  readonly fairId: number;
  constructor(public readonly db: Database.Database, fairId?: number) {
    const fair = fairId === undefined
      ? db.prepare('SELECT id FROM fairs ORDER BY (closed_at IS NULL) DESC, id DESC LIMIT 1').get()
      : db.prepare('SELECT id FROM fairs WHERE id=?').get(fairId);
    requireCondition(fair, 'Feira inexistente.', 404);
    this.fairId = (fair as { id: number }).id;
  }

  fair(): Fair {
    const row = this.db.prepare('SELECT * FROM fairs WHERE id=?').get(this.fairId) as FairRow;
    if (row.closed_at && row.snapshot) return JSON.parse(row.snapshot) as Fair;
    return { id: row.id, name: row.name, targetCents: row.target_cents, startDate: row.start_date,
      endDate: row.end_date, createdAt: row.created_at, closedAt: row.closed_at, summary: this.summary() };
  }
  fairs(): Fair[] {
    return (this.db.prepare('SELECT id FROM fairs ORDER BY id DESC').all() as { id: number }[])
      .map(row => new CashRegister(this.db, row.id).fair());
  }
  private assertFairOpen(): void {
    const row = this.db.prepare('SELECT closed_at FROM fairs WHERE id=?').get(this.fairId) as FairRow;
    requireCondition(!row.closed_at, 'Esta feira está encerrada. Seu histórico foi preservado.');
  }
  saveFair(input: FairInput): Fair {
    return this.db.transaction(() => {
      this.assertFairOpen();
      this.db.prepare('UPDATE fairs SET name=?,target_cents=? WHERE id=?').run(input.name, input.targetCents, this.fairId);
      return this.fair();
    }).immediate();
  }
  createFair(input: FairInput & { startDate: string }): Fair {
    return this.db.transaction(() => {
      requireCondition(!this.db.prepare('SELECT id FROM fairs WHERE closed_at IS NULL').get(), 'Encerre a feira atual antes de iniciar outra.');
      const last = this.db.prepare('SELECT MAX(end_date) AS date FROM fairs').get() as { date: string | null };
      requireCondition(!last.date || input.startDate >= last.date, 'A nova feira não pode começar antes do encerramento anterior.', 400);
      const result = this.db.prepare('INSERT INTO fairs(name,target_cents,start_date,created_at) VALUES(?,?,?,?)')
        .run(input.name, input.targetCents, input.startDate, new Date().toISOString());
      return new CashRegister(this.db, Number(result.lastInsertRowid)).fair();
    }).immediate();
  }
  closeFair(date: string): Fair {
    return this.db.transaction(() => {
      const current = this.fair();
      if (current.closedAt) {
        requireCondition(current.endDate === date, 'A feira já foi encerrada em outra data.');
        return current;
      }
      const sales = this.sales();
      requireCondition(!sales.some(sale => sale.status === 'Pendente'), 'Receba ou cancele os pedidos pendentes antes de encerrar a feira.');
      const dates = new Set([current.startDate, ...sales.flatMap(sale => [sale.date, ...(sale.paymentDate ? [sale.paymentDate] : [])]),
        ...(this.db.prepare('SELECT date FROM days WHERE fair_id=?').all(this.fairId) as { date: string }[]).map(row => row.date)]);
      requireCondition([...dates].every(day => day <= date), 'O encerramento não pode ser anterior aos registros da feira.', 400);
      for (const day of dates) {
        const saved = this.day(day);
        if (!saved.closedAt) this.closeDay(day, saved);
      }
      const closed: Fair = { ...this.fair(), endDate: date, closedAt: new Date().toISOString() };
      this.db.prepare('UPDATE fairs SET end_date=?,closed_at=?,snapshot=? WHERE id=?')
        .run(date, closed.closedAt, JSON.stringify(closed), this.fairId);
      return closed;
    }).immediate();
  }

  owners(): Owner[] { return this.db.prepare('SELECT id, name FROM owners ORDER BY name').all() as Owner[]; }
  products(): Product[] {
    return (this.db.prepare(`SELECT p.id, p.name, p.description, p.owner_id AS ownerId, o.name AS ownerName,
      p.price_cents AS priceCents, p.stock, p.active, p.version FROM products p JOIN owners o ON o.id=p.owner_id ORDER BY o.name, p.name`).all() as (Omit<Product, 'active'> & { active: number })[])
      .map(product => ({ ...product, active: product.active === 1 }));
  }

  saveProduct(input: ProductInput, id?: number): Product {
    return this.db.transaction(() => {
      requireCondition(this.db.prepare('SELECT id FROM owners WHERE id=?').get(input.ownerId), 'Participante inexistente.', 400);
      if (id) {
        const before = this.products().find(product => product.id === id);
        requireCondition(before, 'Produto inexistente.', 404);
        requireCondition(input.expectedVersion === before.version, 'O produto mudou desde que a edição foi aberta. Abra a edição novamente com os dados atualizados.');
        const changed = this.db.prepare('UPDATE products SET name=?, description=?, owner_id=?, price_cents=?, stock=?, active=?, version=version+1 WHERE id=? AND version=?')
          .run(input.name, input.description, input.ownerId, input.priceCents, input.stock, Number(input.active), id, input.expectedVersion);
        requireCondition(changed.changes === 1, 'O produto foi alterado durante a edição. Abra a edição novamente.');
        if (before.stock !== input.stock) this.db.prepare('INSERT INTO stock_adjustments(product_id,before_stock,after_stock,reason,created_at) VALUES(?,?,?,?,?)')
          .run(id, before.stock, input.stock, 'Contagem manual no cadastro', new Date().toISOString());
      } else {
        const result = this.db.prepare('INSERT INTO products(name,description,owner_id,price_cents,stock,active) VALUES(?,?,?,?,?,?)')
          .run(input.name, input.description, input.ownerId, input.priceCents, input.stock, Number(input.active));
        id = Number(result.lastInsertRowid);
      }
      return this.products().find(product => product.id === id)!;
    })();
  }

  sales(): Sale[] {
    const rows = this.db.prepare(`SELECT s.*, CASE WHEN EXISTS(SELECT 1 FROM spreadsheet_records r WHERE r.sale_id=s.id)
      THEN 'Planilha' ELSE 'Aplicativo' END AS origin FROM sales s WHERE s.fair_id=? AND s.deleted_at IS NULL
      ORDER BY s.date DESC, origin ASC, s.created_at DESC, s.rowid DESC`).all(this.fairId) as SaleRow[];
    const allItems = this.db.prepare(`SELECT sale_id AS saleId, product_id AS productId, quantity, name,
      owner_id AS ownerId, owner_name AS ownerName, price_cents AS priceCents, price_cents AS expectedPriceCents,
      discount_cents AS discountCents, fee_cents AS feeCents, gross_cents AS grossCents,
      i.total_cents AS totalCents, i.net_cents AS netCents FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.fair_id=? AND s.deleted_at IS NULL ORDER BY i.id`).all(this.fairId) as (SaleItem & { saleId: string })[];
    return rows.map(row => {
      const items = allItems.filter(item => item.saleId === row.id).map(({ saleId, ...item }) => item);
      const sum = (key: 'grossCents' | 'discountCents' | 'feeCents' | 'totalCents' | 'netCents') => items.reduce((total, item) => total + item[key], 0);
      return { id: row.id, fairId: row.fair_id, date: row.date, paymentDate: row.payment_date, paymentMethod: row.payment_method,
        status: row.status, note: row.note, createdAt: row.created_at, origin: row.origin, items,
        grossCents: sum('grossCents'), discountCents: sum('discountCents'), feeCents: sum('feeCents'), totalCents: sum('totalCents'), netCents: sum('netCents') };
    });
  }

  private assertOpen(date: string): void {
    this.assertFairOpen();
    const start = this.db.prepare('SELECT start_date FROM fairs WHERE id=?').get(this.fairId) as { start_date: string };
    if (date < start.start_date) {
      // A feira inicial recebe também registros anteriores à criação do programa.
      requireCondition(this.fairId === 1 && (this.db.prepare('SELECT COUNT(*) AS n FROM fairs').get() as { n: number }).n === 1,
        'A data é anterior ao início desta feira.', 400);
      this.db.prepare('UPDATE fairs SET start_date=? WHERE id=?').run(date, this.fairId);
    }
    const row = this.db.prepare('SELECT closed_at FROM days WHERE fair_id=? AND date=?').get(this.fairId, date) as { closed_at: string | null } | undefined;
    requireCondition(!row?.closed_at, `O dia ${date} está fechado. Os registros foram preservados.`);
  }

  private changeStock(items: Pick<SaleItem, 'productId' | 'quantity' | 'name'>[], consume: boolean): void {
    for (const item of items) {
      const result = consume
        ? this.db.prepare('UPDATE products SET stock=stock-?, version=version+1 WHERE id=? AND (stock IS NULL OR stock>=?)').run(item.quantity, item.productId, item.quantity)
        : this.db.prepare('UPDATE products SET stock=stock+?, version=version+1 WHERE id=?').run(item.quantity, item.productId);
      requireCondition(result.changes === 1, `Estoque insuficiente: ${item.name}. Nenhum item do pedido foi registrado.`);
    }
  }

  createSale(input: SaleInput): Sale {
    return this.db.transaction(() => {
      requireCondition(input.fairId === undefined || input.fairId === this.fairId, 'O pedido pertence a outra feira.');
      // A feira fica no registro, preservando o hash de retries de clientes anteriores.
      const { fairId: _fairId, ...payload } = input;
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const existing = this.db.prepare('SELECT request_hash,fair_id,deleted_at FROM sales WHERE id=?').get(input.requestId) as { request_hash: string; fair_id: number; deleted_at: string | null } | undefined;
      if (existing) {
        requireCondition(existing.fair_id === this.fairId && existing.request_hash === hash, 'Este pedido já foi enviado com outros valores ou em outra feira. Confira o histórico antes de iniciar outro.');
        requireCondition(!existing.deleted_at, 'Este pedido foi excluído e não será registrado novamente. Inicie um novo pedido somente se for outra venda.', 410);
        return this.sales().find(sale => sale.id === input.requestId)!;
      }
      this.assertOpen(input.date);
      requireCondition(new Set(input.items.map(item => item.productId)).size === input.items.length, 'Agrupe o mesmo produto em um único item.', 400);
      requireCondition(!isNonCash(input.paymentMethod) || input.status === 'Pago', 'Permutas e brindes não podem ficar pendentes.', 400);
      const products = this.products();
      const items = input.items.map(item => {
        const product = products.find(product => product.id === item.productId);
        requireCondition(product, 'Produto inexistente.', 400);
        return calculateItem(product, item, input.paymentMethod);
      });
      this.db.prepare('INSERT INTO sales(id,request_hash,date,payment_date,payment_method,status,note,created_at,fair_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(input.requestId, hash, input.date, input.status === 'Pago' ? input.date : null, input.paymentMethod, input.status, input.note, new Date().toISOString(), this.fairId);
      const insert = this.db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,owner_id,owner_name,quantity,price_cents,
        discount_cents,fee_cents,gross_cents,total_cents,net_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of items) insert.run(input.requestId, item.productId, item.name, item.ownerId, item.ownerName,
        item.quantity, item.priceCents, item.discountCents, item.feeCents, item.grossCents, item.totalCents, item.netCents);
      if (input.status === 'Pago') this.changeStock(items, true);
      return this.sales().find(sale => sale.id === input.requestId)!;
    })();
  }

  receiveSale(id: string, date: string, paymentMethod: PaymentMethod): Sale {
    return this.db.transaction(() => {
      const sale = this.sales().find(sale => sale.id === id);
      requireCondition(sale, 'Pedido inexistente.', 404);
      if (sale.status === 'Pago') {
        requireCondition(sale.paymentDate === date && sale.paymentMethod === paymentMethod, 'Pedido já recebido. Confira o histórico.');
        return sale;
      }
      requireCondition(sale.status === 'Pendente', 'Pedido cancelado não pode ser recebido.');
      requireCondition(date >= sale.date, 'O recebimento não pode ter uma data anterior à do pedido.', 400);
      this.assertOpen(date);
      this.changeStock(sale.items, true);
      this.db.prepare("UPDATE sales SET status='Pago', payment_date=?, payment_method=? WHERE id=?").run(date, paymentMethod, id);
      return this.sales().find(sale => sale.id === id)!;
    })();
  }

  cancelSale(id: string): Sale {
    return this.db.transaction(() => {
      const sale = this.sales().find(sale => sale.id === id);
      requireCondition(sale, 'Pedido inexistente.', 404);
      if (sale.status === 'Cancelado') return sale;
      this.assertFairOpen();
      if (sale.status === 'Pago') { this.assertOpen(sale.paymentDate!); this.changeStock(sale.items, false); }
      this.db.prepare("UPDATE sales SET status='Cancelado' WHERE id=?").run(id);
      return this.sales().find(sale => sale.id === id)!;
    })();
  }

  deleteSale(id: string): { id: string; deleted: true } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT deleted_at FROM sales WHERE id=? AND fair_id=?').get(id, this.fairId) as { deleted_at: string | null } | undefined;
      requireCondition(row, 'Pedido inexistente nesta feira.', 404);
      // Repetir uma exclusão confirmada não muda estoque nem registros fechados.
      if (row.deleted_at) return { id, deleted: true as const };
      const sale = this.sales().find(sale => sale.id === id)!;
      this.assertOpen(sale.date);
      if (sale.paymentDate && sale.paymentDate !== sale.date) this.assertOpen(sale.paymentDate);
      if (sale.status === 'Pago') this.changeStock(sale.items, false);
      this.db.prepare('UPDATE sales SET deleted_at=? WHERE id=? AND fair_id=?')
        .run(new Date().toISOString(), id, this.fairId);
      return { id, deleted: true as const };
    }).immediate();
  }

  summary(date?: string): Summary { return summarize(this.sales(), this.owners(), date); }

  day(date: string): Day {
    const row = this.db.prepare('SELECT * FROM days WHERE fair_id=? AND date=?').get(this.fairId, date) as DayRow | undefined;
    if (row?.closed_at && row.snapshot) return JSON.parse(row.snapshot) as Day;
    const summary = this.summary(date);
    const openingCents = row?.opening_cents ?? 0, extraCents = row?.extra_cents ?? 0, withdrawalCents = row?.withdrawal_cents ?? 0;
    const expectedCents = openingCents + extraCents - withdrawalCents + summary.byPayment.find(payment => payment.method === 'Dinheiro')!.totalCents;
    const countedCents = row?.counted_cents ?? null;
    return { date, summary, openingCents, extraCents, withdrawalCents, countedCents, note: row?.note ?? '', closedAt: null,
      expectedCents, differenceCents: countedCents === null ? null : countedCents - expectedCents };
  }

  saveDay(date: string, cash: CashInput): Day {
    return this.db.transaction(() => {
      this.assertOpen(date);
      this.db.prepare(`INSERT INTO days(fair_id,date,opening_cents,extra_cents,withdrawal_cents,counted_cents,note) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(fair_id,date) DO UPDATE SET opening_cents=excluded.opening_cents,extra_cents=excluded.extra_cents,
        withdrawal_cents=excluded.withdrawal_cents,counted_cents=excluded.counted_cents,note=excluded.note`)
        .run(this.fairId, date, cash.openingCents, cash.extraCents, cash.withdrawalCents, cash.countedCents, cash.note);
      return this.day(date);
    })();
  }

  closeDay(date: string, cash: CashInput): Day {
    return this.db.transaction(() => {
      const current = this.day(date);
      if (current.closedAt) {
        requireCondition(current.openingCents === cash.openingCents && current.extraCents === cash.extraCents &&
          current.withdrawalCents === cash.withdrawalCents && current.countedCents === cash.countedCents && current.note === cash.note,
          'O fechamento já foi guardado com outros valores. Nada foi alterado.');
        return current;
      }
      const day = this.saveDay(date, cash);
      const closed = { ...day, closedAt: new Date().toISOString() };
      this.db.prepare('UPDATE days SET closed_at=?, snapshot=? WHERE fair_id=? AND date=?').run(closed.closedAt, JSON.stringify(closed), this.fairId, date);
      return closed;
    })();
  }

  bootstrap(date: string): Bootstrap {
    const closed = this.db.prepare('SELECT snapshot FROM days WHERE fair_id=? AND closed_at IS NOT NULL ORDER BY date DESC').all(this.fairId) as { snapshot: string }[];
    const fair = this.fair();
    const active = this.db.prepare('SELECT id FROM fairs WHERE closed_at IS NULL').get() as { id: number } | undefined;
    return { fair, fairs: this.fairs(), activeFairId: active?.id ?? null,
      owners: this.owners(), products: this.products(), sales: this.sales(), day: this.day(date),
      total: fair.summary, closedDays: closed.map(row => JSON.parse(row.snapshot) as Day) };
  }
}
