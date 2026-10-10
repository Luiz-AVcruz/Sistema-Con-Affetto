import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError, z } from 'zod';
import { CashRegister } from './cash-register.js';
import { BusinessError, businessDate, cashSchema, fairSchema, newFairSchema, productSchema, productUpdateSchema, receiveSchema, saleSchema } from './validation.js';

function csvCell(value: string | number): string {
  const text = String(value);
  // Nomes e observações não devem virar fórmulas quando o CSV for aberto no Calc.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function createApp(register: CashRegister, frontend?: string) {
  const app = express();
  const context = (fairId: unknown) => new CashRegister(register.db, fairId === undefined ? undefined : z.coerce.number().int().positive().parse(fairId));
  const exportFairs = (fairId: unknown) => fairId === undefined ? register.fairs() : [context(fairId).fair()];
  const reais = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host?.split(':')[0];
    if (!host || !['127.0.0.1', 'localhost'].includes(host)) { res.status(403).json({ error: 'Acesso permitido apenas pelo endereço local.' }); return; }
    const origins = [req.socket.localPort, 4200].flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (req.headers.origin && !origins.includes(req.headers.origin)) { res.status(403).json({ error: 'Origem não autorizada.' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json({ error: 'Envie os dados como JSON.' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
  app.get('/api/bootstrap', (req, res) => res.json(context(req.query['fairId']).bootstrap(businessDate.parse(req.query['date']))));
  app.post('/api/fairs', (req, res) => res.status(201).json(context(undefined).createFair(newFairSchema.parse(req.body))));
  app.put('/api/fairs/:id', (req, res) => res.json(context(req.params['id']).saveFair(fairSchema.parse(req.body))));
  app.post('/api/fairs/:id/close', (req, res) => {
    const input = z.object({ date: businessDate }).strict().parse(req.body);
    res.json(context(req.params['id']).closeFair(input.date));
  });
  app.post('/api/owners', (req, res) => {
    const name = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(req.body).name;
    register.db.prepare('INSERT INTO owners(name) VALUES(?) ON CONFLICT(name) DO NOTHING').run(name);
    res.status(201).json(register.owners().find(owner => owner.name === name));
  });
  app.post('/api/products', (req, res) => res.status(201).json(register.saveProduct(productSchema.parse(req.body))));
  app.put('/api/products/:id', (req, res) => res.json(register.saveProduct(productUpdateSchema.parse(req.body), z.coerce.number().int().positive().parse(req.params['id']))));
  app.post('/api/sales', (req, res) => {
    const input = saleSchema.parse(req.body);
    res.status(201).json(context(input.fairId).createSale(input));
  });
  app.post('/api/sales/:id/receive', (req, res) => {
    const input = receiveSchema.parse(req.body);
    res.json(context(req.query['fairId']).receiveSale(z.uuid().parse(req.params['id']), input.date, input.paymentMethod));
  });
  app.post('/api/sales/:id/cancel', (req, res) => res.json(context(req.query['fairId']).cancelSale(z.uuid().parse(req.params['id']))));
  app.put('/api/days/:date', (req, res) => res.json(context(req.query['fairId']).saveDay(businessDate.parse(req.params['date']), cashSchema.parse(req.body))));
  app.post('/api/days/:date/close', (req, res) => res.json(context(req.query['fairId']).closeDay(businessDate.parse(req.params['date']), cashSchema.parse(req.body))));
  app.get('/api/export/sales.csv', (req, res) => {
    const header = ['Pedido', 'Data do pedido', 'Data do recebimento', 'Situação', 'Pagamento', 'Produto', 'Participante', 'Quantidade', 'Preço unitário', 'Desconto', 'Taxa', 'Valor registrado', 'Parte registrada', 'Recebido', 'Líquido recebido', 'Observação', 'Registrado em (UTC)', 'Origem', 'Feira ID', 'Feira'];
    const rows = exportFairs(req.query['fairId']).flatMap(fair => new CashRegister(register.db, fair.id).sales().flatMap(sale => sale.items.map(item => [sale.id, sale.date, sale.paymentDate ?? '', sale.status,
      sale.paymentMethod, item.name, item.ownerName, item.quantity, reais(item.priceCents), reais(item.discountCents),
      reais(item.feeCents), reais(item.totalCents), reais(item.netCents),
      reais(sale.status === 'Pago' ? item.totalCents : 0), reais(sale.status === 'Pago' ? item.netCents : 0), sale.note,
      sale.origin === 'Aplicativo' ? sale.createdAt : '', sale.origin, fair.id, fair.name])));
    res.setHeader('Content-Disposition', 'attachment; filename="vendas-feira.csv"');
    res.type('text/csv; charset=utf-8').send('\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n'));
  });
  app.get('/api/export/fairs.csv', (_req, res) => {
    const fairs = register.fairs();
    const owners = [...new Set(fairs.flatMap(fair => fair.summary.byOwner.map(owner => owner.name)))];
    const header = ['Feira ID','Feira','Situação','Início','Encerramento','Meta','Recebido','Líquido recebido','Descontos','Taxas','Pendente','Pedidos pagos','Permutas (unidades)','Brindes (unidades)',
      'Dinheiro','Pix','Cartão débito','Cartão crédito',...owners.map(name => `Parte de ${name}`)];
    const rows = fairs.map(fair => [fair.id,fair.name,fair.closedAt ? 'Encerrada' : 'Em andamento',fair.startDate,fair.endDate ?? '',fair.targetCents === null ? '' : reais(fair.targetCents),
      ...(['receivedCents','netCents','discountCents','feeCents','pendingCents'] as const).map(key => reais(fair.summary[key])),fair.summary.paidCount,fair.summary.barterUnits,fair.summary.giftUnits,
      ...fair.summary.byPayment.map(payment => reais(payment.totalCents)),...owners.map(name => reais(fair.summary.byOwner.find(owner => owner.name === name)?.netCents ?? 0))]);
    res.setHeader('Content-Disposition', 'attachment; filename="historico-feiras.csv"');
    res.type('text/csv; charset=utf-8').send('\uFEFF' + [header,...rows].map(row => row.map(csvCell).join(';')).join('\r\n'));
  });
  app.get('/api/export/days.csv', (req, res) => {
    const header = ['Feira ID','Feira','Dia','Situação','Recebido','Líquido recebido','Pendente','Troco inicial','Entradas extras','Retiradas','Dinheiro esperado','Dinheiro contado','Diferença','Observação'];
    const rows = exportFairs(req.query['fairId']).flatMap(fair => {
      const selected = new CashRegister(register.db,fair.id);
      const dates = register.db.prepare(`SELECT date FROM days WHERE fair_id=? UNION SELECT date FROM sales WHERE fair_id=?
        UNION SELECT payment_date AS date FROM sales WHERE fair_id=? AND payment_date IS NOT NULL ORDER BY date`).all(fair.id,fair.id,fair.id) as { date: string }[];
      return dates.map(({ date }) => {
        const day = selected.day(date);
        return [fair.id,fair.name,date,day.closedAt ? 'Fechado' : 'Em andamento',reais(day.summary.receivedCents),reais(day.summary.netCents),reais(day.summary.pendingCents),
          reais(day.openingCents),reais(day.extraCents),reais(day.withdrawalCents),reais(day.expectedCents),day.countedCents === null ? '' : reais(day.countedCents),
          day.differenceCents === null ? '' : reais(day.differenceCents),day.note];
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="fechamentos.csv"');
    res.type('text/csv; charset=utf-8').send('\uFEFF' + [header,...rows].map(row => row.map(csvCell).join(';')).join('\r\n'));
  });
  app.get('/api/backup', (_req, res) => {
    const date = new Date().toISOString().replaceAll(':', '-');
    res.setHeader('Content-Disposition', `attachment; filename="caixa-feira-${date}.sqlite"`);
    res.type('application/octet-stream').send(register.db.serialize());
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota da API inexistente.' }));
  if (frontend && existsSync(resolve(frontend, 'index.html'))) {
    app.use(express.static(frontend));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(frontend, 'index.html')));
  } else app.get('/', (_req, res) => res.type('text').send('API do caixa funcionando. Execute npm run build para abrir a interface ou npm run dev para desenvolver.'));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError) { res.status(400).json({ error: 'Confira os campos informados.', details: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) }); return; }
    if (error instanceof BusinessError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'JSON inválido.' }); return; }
    console.error(error);
    res.status(500).json({ error: 'Não foi possível concluir a operação. Confira o histórico antes de tentar novamente.' });
  };
  app.use(errors);
  return app;
}
