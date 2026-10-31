const db = require('./db');
const { auth } = require('./auth');
const { runBilling } = require('./billing');
const cron = require('node-cron');

module.exports = (app) => {
  // Generic CRUD: admin writes, admin+staff read
  const crud = (path, table, cols) => {
    app.get(`/api/${path}`, auth('admin', 'staff'), (q, r) => r.json(db.prepare(`SELECT * FROM ${table}`).all()));
    app.post(`/api/${path}`, auth('admin'), (q, r) => {
      const x = db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${cols.split(',').map(() => '?')})`)
        .run(...cols.split(',').map(c => q.body[c] ?? null));
      r.json({ id: x.lastInsertRowid });
    });
    app.put(`/api/${path}/:id`, auth('admin'), (q, r) => {
      const set = cols.split(',').map(c => `${c}=?`).join(',');
      db.prepare(`UPDATE ${table} SET ${set} WHERE id=?`).run(...cols.split(',').map(c => q.body[c] ?? null), q.params.id);
      r.json({ ok: true });
    });
    app.delete(`/api/${path}/:id`, auth('admin'), (q, r) => {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(q.params.id); r.json({ ok: true });
    });
  };
  crud('products', 'products', 'name,type,sales_price,cost_price,notes');
  crud('variants', 'variants', 'product_id,attribute,value,extra_price');
  crud('plans', 'plans', 'name,price,period,min_qty,start_date,end_date,auto_close,closable,pausable,renewable');
  crud('taxes', 'taxes', 'name,rate');
  crud('discounts', 'discounts', 'name,type,value,min_amount,min_qty,start_date,end_date,usage_limit,product_id');

  // Subscriptions
  app.post('/api/subscriptions', auth('admin', 'staff'), (q, r) => {
    const b = q.body;
    const tx = db.transaction(() => {
      const s = db.prepare(`INSERT INTO subscriptions(number,customer_id,plan_id,start_date,expiry_date,payment_terms)
        VALUES(?,?,?,?,?,?)`).run('SUB-' + Date.now(), b.customer_id, b.plan_id, b.start_date, b.expiry_date, b.payment_terms);
      for (const l of b.lines || []) {
        const p = db.prepare('SELECT sales_price FROM products WHERE id=?').get(l.product_id);
        const v = l.variant_id ? db.prepare('SELECT extra_price FROM variants WHERE id=?').get(l.variant_id) : null;
        db.prepare('INSERT INTO sub_lines(sub_id,product_id,variant_id,qty,unit_price,tax_id) VALUES(?,?,?,?,?,?)')
          .run(s.lastInsertRowid, l.product_id, l.variant_id || null, l.qty, p.sales_price + (v ? v.extra_price : 0), l.tax_id || null);
      }
      return s.lastInsertRowid;
    });
    r.json({ id: tx() });
  });

  const FLOW = { Draft: 'Quotation', Quotation: 'Confirmed', Confirmed: 'Active', Active: 'Closed' };
  app.post('/api/subscriptions/:id/advance', auth('admin', 'staff'), (q, r) => {
    const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(q.params.id);
    if (!s || !FLOW[s.status]) return r.status(400).json({ error: 'Cannot move from ' + (s && s.status) });
    const to = FLOW[s.status];
    db.prepare('UPDATE subscriptions SET status=?, next_billing=COALESCE(?,next_billing) WHERE id=?')
      .run(to, to === 'Active' ? s.start_date : null, s.id);
    r.json({ status: to });
  });
  app.post('/api/subscriptions/:id/pause', auth('admin', 'staff'), (q, r) => {
    db.prepare('UPDATE subscriptions SET paused = 1 - paused WHERE id=?').run(q.params.id); r.json({ ok: true });
  });
  app.get('/api/subscriptions', auth('admin', 'staff'), (q, r) => {
    const page = Math.max(1, +q.query.page || 1);
    const rows = q.query.status
      ? db.prepare('SELECT * FROM subscriptions WHERE status=? ORDER BY id DESC LIMIT 20 OFFSET ?').all(q.query.status, (page - 1) * 20)
      : db.prepare('SELECT * FROM subscriptions ORDER BY id DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
    r.json(rows);
  });

  // Billing
  app.post('/api/billing/run', auth('admin', 'staff'), (q, r) => r.json({ invoices_created: runBilling(q.body.date) }));
  cron.schedule('0 1 * * *', () => console.log('Billing job created', runBilling(), 'invoices'));

  // Invoices
  app.get('/api/invoices', auth('admin', 'staff'), (q, r) => {
    const page = Math.max(1, +q.query.page || 1);
    const rows = q.query.status
      ? db.prepare('SELECT * FROM invoices WHERE status=? ORDER BY id DESC LIMIT 20 OFFSET ?').all(q.query.status, (page - 1) * 20)
      : db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 20 OFFSET ?').all((page - 1) * 20);
    r.json(rows);
  });
  app.get('/api/invoices/:id', auth('admin', 'staff'), (q, r) => r.json({
    ...db.prepare('SELECT * FROM invoices WHERE id=?').get(q.params.id),
    lines: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(q.params.id),
    payments: db.prepare('SELECT * FROM payments WHERE invoice_id=?').all(q.params.id) }));
  app.post('/api/invoices/:id/confirm', auth('admin', 'staff'), (q, r) => {
    const x = db.prepare("UPDATE invoices SET status='Confirmed' WHERE id=? AND status='Draft'").run(q.params.id);
    x.changes ? r.json({ ok: true }) : r.status(400).json({ error: 'Only Draft invoices can be confirmed' });
  });
  app.post('/api/invoices/:id/cancel', auth('admin', 'staff'), (q, r) => {
    const x = db.prepare("UPDATE invoices SET status='Cancelled' WHERE id=? AND status IN ('Draft','Confirmed')").run(q.params.id);
    x.changes ? r.json({ ok: true }) : r.status(400).json({ error: 'Cannot cancel this invoice' });
  });

  // Payments
  app.post('/api/payments', auth('admin', 'staff'), (q, r) => {
    const { invoice_id, method, amount, date, note } = q.body;
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice_id);
    if (!inv || inv.status !== 'Confirmed') return r.status(400).json({ error: 'Invoice must be Confirmed' });
    if (amount <= 0 || inv.amount_paid + amount > inv.total + 0.001) return r.status(400).json({ error: 'Invalid amount' });
    db.transaction(() => {
      db.prepare('INSERT INTO payments(invoice_id,method,amount,date,note) VALUES(?,?,?,?,?)').run(invoice_id, method, amount, date, note);
      const paid = inv.amount_paid + amount;
      db.prepare('UPDATE invoices SET amount_paid=?, status=? WHERE id=?').run(paid, paid >= inv.total - 0.001 ? 'Paid' : 'Confirmed', invoice_id);
    })();
    r.json({ ok: true });
  });

  // Dashboard
  app.get('/api/reports/summary', auth('admin', 'staff'), (q, r) => {
    const today = new Date().toISOString().slice(0, 10);
    r.json({
      active_subscriptions: db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE status='Active'").get().c,
      revenue: db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments').get().s,
      outstanding: db.prepare("SELECT COALESCE(SUM(total-amount_paid),0) s FROM invoices WHERE status='Confirmed'").get().s,
      overdue: db.prepare("SELECT * FROM invoices WHERE status='Confirmed' AND due_date<? ORDER BY due_date LIMIT 50").all(today) });
  });

  // Customer portal (only their own data)
  app.get('/api/my/invoices', auth('customer'), (q, r) =>
    r.json(db.prepare('SELECT * FROM invoices WHERE customer_id=? ORDER BY id DESC').all(q.user.id)));
  app.get('/api/my/subscriptions', auth('customer'), (q, r) =>
    r.json(db.prepare('SELECT * FROM subscriptions WHERE customer_id=? ORDER BY id DESC').all(q.user.id)));
};