const db = require('./db'), bcrypt = require('bcryptjs'), crypto = require('crypto');
const { auth } = require('./auth');
const S = ['admin', 'staff'];
const pwRule = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{9,}$/;
const PWMSG = 'Password must be 9+ chars with upper, lower and special character';
const FACTOR = { daily: 30, weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addPeriod = (d, p) => {
  const x = new Date(d);
  if (p === 'daily') x.setUTCDate(x.getUTCDate() + 1);
  else if (p === 'weekly') x.setUTCDate(x.getUTCDate() + 7);
  else if (p === 'monthly') x.setUTCMonth(x.getUTCMonth() + 1);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x.toISOString().slice(0, 10);
};
const page = q => Math.max(1, +q.page || 1);
// Builds a WHERE clause from [sql, value] pairs; empty/undefined values are skipped
const W = pairs => {
  const p = pairs.filter(x => x[1] !== undefined && x[1] !== '');
  return [p.length ? 'WHERE ' + p.map(x => x[0]).join(' AND ') : '', p.flatMap(x => Array.isArray(x[1]) ? x[1] : [x[1]])];
};
const price = (pid, vid) => {
  const p = db.prepare('SELECT sales_price FROM products WHERE id=?').get(pid);
  const v = vid ? db.prepare('SELECT extra_price FROM variants WHERE id=?').get(vid) : null;
  return p.sales_price + (v ? v.extra_price : 0);
};
const subDetail = id => {
  const s = db.prepare(`SELECT s.*, p.name plan_name, p.period, p.closable, p.pausable, p.renewable,
    u.name customer_name, u.email customer_email FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.customer_id WHERE s.id=?`).get(id);
  if (!s) return null;
  s.lines = db.prepare(`SELECT l.*, p.name product_name, v.value variant, COALESCE(t.rate,0) rate FROM sub_lines l
    JOIN products p ON p.id=l.product_id LEFT JOIN variants v ON v.id=l.variant_id
    LEFT JOIN taxes t ON t.id=l.tax_id WHERE l.sub_id=?`).all(id).map(l => {
      const net = l.qty * l.unit_price, tax = Math.round(net * l.rate) / 100;
      return { ...l, tax, total: Math.round((net + tax) * 100) / 100 };
    });
  return s;
};
const invDetail = id => {
  const i = db.prepare(`SELECT i.*, u.name customer_name, u.email customer_email, u.company, u.address
    FROM invoices i JOIN users u ON u.id=i.customer_id WHERE i.id=?`).get(id);
  if (!i) return null;
  i.lines = db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=?').all(id);
  i.payments = db.prepare('SELECT * FROM payments WHERE invoice_id=? ORDER BY id').all(id);
  return i;
};

module.exports = (app) => {
  // ---------- Password reset (link is printed in the server console for the demo) ----------
  app.post('/api/forgot', (q, r) => {
    const u = db.prepare('SELECT id FROM users WHERE email=?').get(q.body.email);
    if (u) {
      const t = crypto.randomBytes(24).toString('hex');
      db.prepare('UPDATE users SET reset_token=?, reset_expiry=? WHERE id=?')
        .run(crypto.createHash('sha256').update(t).digest('hex'), Date.now() + 3600000, u.id);
      console.log('PASSWORD RESET LINK: http://localhost:3000/reset.html?token=' + t);
    }
    r.json({ ok: true });
  });
  app.post('/api/reset', (q, r) => {
    const { token, password } = q.body;
    if (!pwRule.test(password || '')) return r.status(400).json({ error: PWMSG });
    const h = crypto.createHash('sha256').update(token || '').digest('hex');
    const u = db.prepare('SELECT id FROM users WHERE reset_token=? AND reset_expiry>?').get(h, Date.now());
    if (!u) return r.status(400).json({ error: 'This reset link is invalid or has expired' });
    db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_expiry=NULL WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
    r.json({ ok: true });
  });

  // ---------- Generic admin CRUD (payment terms) ----------
  const crud = (path, table, cols) => {
    const cs = cols.split(',');
    app.get(`/api/${path}`, auth(), (q, r) => r.json(db.prepare(`SELECT * FROM ${table}`).all()));
    app.post(`/api/${path}`, auth('admin'), (q, r) => r.json({
      id: db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${cs.map(() => '?')})`).run(...cs.map(c => q.body[c] ?? null)).lastInsertRowid }));
    app.put(`/api/${path}/:id`, auth('admin'), (q, r) => {
      db.prepare(`UPDATE ${table} SET ${cs.map(c => c + '=?').join(',')} WHERE id=?`).run(...cs.map(c => q.body[c] ?? null), q.params.id);
      r.json({ ok: true });
    });
    app.delete(`/api/${path}/:id`, auth('admin'), (q, r) => { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(q.params.id); r.json({ ok: true }); });
  };
  crud('terms', 'payment_terms', 'name,days');

  // ---------- Company settings ----------
  app.get('/api/company', auth(), (q, r) => {
    const o = {}; db.prepare('SELECT * FROM settings').all().forEach(x => o[x.key] = x.value); r.json(o);
  });
  app.put('/api/company', auth('admin'), (q, r) => {
    const st = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const k of ['company_name', 'address', 'email', 'phone', 'tax_id', 'invoice_footer', 'methods', 'gateway'])
      if (k in q.body) st.run(k, String(q.body[k] ?? ''));
    r.json({ ok: true });
  });

  // ---------- Users and roles (admin) ----------
  app.get('/api/users', auth('admin'), (q, r) =>
    r.json(db.prepare("SELECT id,name,email,role FROM users WHERE role IN ('admin','staff') ORDER BY id").all()));
  app.put('/api/users/:id/role', auth('admin'), (q, r) => {
    if (+q.params.id === q.user.id) return r.status(400).json({ error: "You can't change your own role" });
    if (!['admin', 'staff'].includes(q.body.role)) return r.status(400).json({ error: 'Invalid role' });
    db.prepare("UPDATE users SET role=? WHERE id=? AND role IN ('admin','staff')").run(q.body.role, q.params.id);
    db.audit('user', +q.params.id, 'Role set to ' + q.body.role, q.user.id);
    r.json({ ok: true });
  });

  // ---------- Customers (staff + admin) ----------
  app.get('/api/clients', auth(...S), (q, r) => {
    const like = '%' + (q.query.q || '') + '%';
    const act = "EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=users.id AND s.status='Active')";
    const st = q.query.status === 'active' ? 'AND ' + act : q.query.status === 'inactive' ? 'AND NOT ' + act : '';
    r.json(db.prepare(`SELECT id,name,email,company,phone,address,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.customer_id=users.id AND s.status='Active') active_subs,
      (SELECT COALESCE(SUM(total-amount_paid),0) FROM invoices i WHERE i.customer_id=users.id AND i.status='Confirmed') owed
      FROM users WHERE role='customer' AND (name LIKE ? OR email LIKE ? OR COALESCE(company,'') LIKE ?) ${st}
      ORDER BY id DESC LIMIT 200`).all(like, like, like));
  });
  app.post('/api/clients', auth(...S), (q, r) => {
    const { name, email, company, phone, address, password } = q.body;
    if (!name || !email) return r.status(400).json({ error: 'Name and email are required' });
    if (!pwRule.test(password || '')) return r.status(400).json({ error: PWMSG });
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return r.status(400).json({ error: 'Email already registered' });
    r.json({ id: db.prepare("INSERT INTO users(name,email,password_hash,role,company,phone,address) VALUES(?,?,?,'customer',?,?,?)")
      .run(name, email, bcrypt.hashSync(password, 10), company || null, phone || null, address || null).lastInsertRowid });
  });
  app.put('/api/clients/:id', auth(...S), (q, r) => {
    const { name, email, company, phone, address } = q.body;
    try {
      db.prepare("UPDATE users SET name=?,email=?,company=?,phone=?,address=? WHERE id=? AND role='customer'")
        .run(name, email, company || null, phone || null, address || null, q.params.id);
      r.json({ ok: true });
    } catch { r.status(400).json({ error: 'Email already used by another account' }); }
  });
  app.get('/api/clients/:id', auth(...S), (q, r) => {
    const c = db.prepare("SELECT id,name,email,company,phone,address FROM users WHERE id=? AND role='customer'").get(q.params.id);
    if (!c) return r.status(404).json({ error: 'Customer not found' });
    c.subs = db.prepare('SELECT s.*, p.name plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=? ORDER BY s.id DESC').all(c.id);
    c.invoices = db.prepare('SELECT * FROM invoices WHERE customer_id=? ORDER BY id DESC').all(c.id);
    c.payments = db.prepare('SELECT p.*, i.number invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.customer_id=? ORDER BY p.id DESC').all(c.id);
    r.json(c);
  });

  // ---------- Subscriptions (staff view) ----------
  app.get('/api/subs', auth(...S), (q, r) => {
    const [w, a] = W([['s.status=?', q.query.status], ['s.customer_id=?', q.query.customer], ['s.plan_id=?', q.query.plan],
      ['(s.number LIKE ? OR u.name LIKE ?)', q.query.q ? ['%' + q.query.q + '%', '%' + q.query.q + '%'] : undefined]]);
    const lim = Math.min(+q.query.limit || 50, 200);
    r.json(db.prepare(`SELECT s.*, u.name customer_name, p.name plan_name FROM subscriptions s
      JOIN users u ON u.id=s.customer_id JOIN plans p ON p.id=s.plan_id ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`)
      .all(...a, lim, (page(q.query) - 1) * lim));
  });
  app.get('/api/subs/:id', auth(...S), (q, r) => {
    const s = subDetail(q.params.id);
    if (!s) return r.status(404).json({ error: 'Subscription not found' });
    s.audit = db.prepare(`SELECT a.at, u.name who, a.action FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity='subscription' AND a.entity_id=? ORDER BY a.id DESC`).all(s.id);
    r.json(s);
  });

  // ---------- Quotation templates ----------
  app.get('/api/templates', auth(...S), (q, r) => r.json(db.prepare(
    'SELECT t.*, p.name plan_name FROM templates t LEFT JOIN plans p ON p.id=t.plan_id ORDER BY t.id DESC').all()));
  app.post('/api/templates', auth('admin'), (q, r) => {
    const b = q.body;
    if (!b.name || !b.plan_id) return r.status(400).json({ error: 'Name and plan are required' });
    r.json({ id: db.transaction(() => {
      const t = db.prepare('INSERT INTO templates(name,validity_days,plan_id) VALUES(?,?,?)').run(b.name, b.validity_days || 30, b.plan_id);
      for (const l of b.lines || [])
        db.prepare('INSERT INTO template_lines(template_id,product_id,variant_id,qty,tax_id) VALUES(?,?,?,?,?)')
          .run(t.lastInsertRowid, l.product_id, l.variant_id || null, l.qty || 1, l.tax_id || null);
      return t.lastInsertRowid;
    })() });
  });
  app.delete('/api/templates/:id', auth('admin'), (q, r) => {
    db.transaction(() => {
      db.prepare('DELETE FROM template_lines WHERE template_id=?').run(q.params.id);
      db.prepare('DELETE FROM templates WHERE id=?').run(q.params.id);
    })();
    r.json({ ok: true });
  });
  app.post('/api/templates/:id/apply', auth(...S), (q, r) => {
    const t = db.prepare('SELECT * FROM templates WHERE id=?').get(q.params.id);
    if (!t) return r.status(404).json({ error: 'Template not found' });
    if (!q.body.customer_id) return r.status(400).json({ error: 'Choose a customer' });
    const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(t.plan_id);
    const lines = db.prepare('SELECT * FROM template_lines WHERE template_id=?').all(t.id);
    r.json({ id: db.transaction(() => {
      const s = db.prepare(`INSERT INTO subscriptions(number,customer_id,plan_id,start_date,expiry_date,payment_terms,status,valid_until,template_id)
        VALUES(?,?,?,?,?,?,'Quotation',?,?)`).run('SUB-' + Date.now(), q.body.customer_id, t.plan_id, q.body.start_date || today(),
        (plan && plan.end_date) || null, q.body.payment_terms || 'Net 15', addDays(today(), t.validity_days || 30), t.id);
      for (const l of lines)
        db.prepare('INSERT INTO sub_lines(sub_id,product_id,variant_id,qty,unit_price,tax_id) VALUES(?,?,?,?,?,?)')
          .run(s.lastInsertRowid, l.product_id, l.variant_id, l.qty, price(l.product_id, l.variant_id), l.tax_id);
      db.audit('subscription', s.lastInsertRowid, 'Created from template ' + t.name, q.user.id);
      return s.lastInsertRowid;
    })() });
  });

  // ---------- Invoices (staff view) ----------
  app.get('/api/inv', auth(...S), (q, r) => {
    const t = today(), s = q.query.status, od = s === 'Overdue';
    const [w, a] = W([[od ? "i.status='Confirmed' AND i.due_date<?" : 'i.status=?', od ? t : s],
      ['i.customer_id=?', q.query.customer], ['i.period_start>=?', q.query.from], ['i.period_start<=?', q.query.to],
      ['(i.number LIKE ? OR u.name LIKE ?)', q.query.q ? ['%' + q.query.q + '%', '%' + q.query.q + '%'] : undefined]]);
    const lim = Math.min(+q.query.limit || 50, 200);
    r.json(db.prepare(`SELECT i.*, u.name customer_name FROM invoices i JOIN users u ON u.id=i.customer_id ${w}
      ORDER BY i.id DESC LIMIT ? OFFSET ?`).all(...a, lim, (page(q.query) - 1) * lim)
      .map(x => ({ ...x, overdue: x.status === 'Confirmed' && x.due_date < t })));
  });
  app.get('/api/inv/:id', auth(...S), (q, r) => {
    const i = invDetail(q.params.id);
    i ? r.json(i) : r.status(404).json({ error: 'Invoice not found' });
  });
  app.post('/api/inv/:id/send', auth(...S), (q, r) => {
    const i = invDetail(q.params.id);
    if (!i) return r.status(404).json({ error: 'Invoice not found' });
    db.prepare("UPDATE invoices SET sent_at=datetime('now') WHERE id=?").run(i.id);
    db.audit('invoice', i.id, 'Emailed to ' + i.customer_email, q.user.id);
    console.log(`EMAIL to ${i.customer_email}: invoice ${i.number}, total ${i.total}`);
    r.json({ ok: true, to: i.customer_email });
  });

  // ---------- Payments (staff view) ----------
  app.get('/api/pay', auth(...S), (q, r) => {
    const [w, a] = W([['p.method=?', q.query.method], ['p.date>=?', q.query.from], ['p.date<=?', q.query.to],
      ['i.customer_id=?', q.query.customer], ['s.plan_id=?', q.query.plan]]);
    r.json(db.prepare(`SELECT p.*, i.number invoice_number, u.name customer_name FROM payments p
      JOIN invoices i ON i.id=p.invoice_id JOIN users u ON u.id=i.customer_id JOIN subscriptions s ON s.id=i.sub_id
      ${w} ORDER BY p.id DESC LIMIT 200`).all(...a));
  });

  // ---------- Reports ----------
  app.get('/api/activity', auth(...S), (q, r) => r.json(db.prepare(`SELECT a.at, u.name who, a.entity, a.entity_id, a.action
    FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 10`).all()));
  app.get('/api/rep/overview', auth(...S), (q, r) => {
    const t = today(), n = (sql, ...a) => db.prepare(sql).get(...a);
    const mrr = db.prepare(`SELECT p.period, SUM(l.qty*l.unit_price) amt FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      JOIN sub_lines l ON l.sub_id=s.id WHERE s.status='Active' AND s.paused=0 GROUP BY p.period`).all()
      .reduce((a, x) => a + x.amt * FACTOR[x.period], 0);
    const od = n("SELECT COUNT(*) c, COALESCE(SUM(total-amount_paid),0) s FROM invoices WHERE status='Confirmed' AND due_date<?", t);
    r.json({
      active: n("SELECT COUNT(*) c FROM subscriptions WHERE status='Active'").c,
      pending_quotes: n("SELECT COUNT(*) c FROM subscriptions WHERE status='Quotation'").c,
      mrr: Math.round(mrr), arr: Math.round(mrr * 12),
      revenue: n('SELECT COALESCE(SUM(amount),0) s FROM payments').s,
      outstanding: n("SELECT COALESCE(SUM(total-amount_paid),0) s FROM invoices WHERE status='Confirmed'").s,
      overdue_count: od.c, overdue_amount: od.s });
  });
  app.get('/api/rep/trend', auth(...S), (q, r) => {
    const [w, a] = W([['p.date>=?', q.query.from], ['p.date<=?', q.query.to], ['p.method=?', q.query.method],
      ['i.customer_id=?', q.query.customer], ['s.plan_id=?', q.query.plan]]);
    const from = `FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN subscriptions s ON s.id=i.sub_id
      JOIN plans pl ON pl.id=s.plan_id ${w}`;
    const g = (col, name) => db.prepare(`SELECT ${col} ${name}, ROUND(SUM(p.amount),2) total ${from} GROUP BY 1 ORDER BY 1`).all(...a);
    r.json({ monthly: g('substr(p.date,1,7)', 'month'), yearly: g('substr(p.date,1,4)', 'year'), by_plan: g('pl.name', 'plan') });
  });
  app.get('/api/rep/aging', auth(...S), (q, r) => {
    const t = today();
    const rows = db.prepare(`SELECT i.id,i.number,i.total,i.amount_paid,i.due_date,u.name customer_name FROM invoices i
      JOIN users u ON u.id=i.customer_id WHERE i.status='Confirmed' AND i.due_date<? ORDER BY i.due_date`).all(t).map(x => {
        const d = Math.floor((Date.parse(t) - Date.parse(x.due_date)) / 864e5);
        return { ...x, owed: Math.round((x.total - x.amount_paid) * 100) / 100, days: d, bucket: d <= 30 ? '1-30' : d <= 60 ? '31-60' : '60+' };
      });
    const buckets = { '1-30': 0, '31-60': 0, '60+': 0 };
    rows.forEach(x => buckets[x.bucket] += x.owed);
    r.json({ rows, buckets });
  });
  app.get('/api/rep/export/:type', auth('admin'), (q, r) => {
    const sql = {
      invoices: 'SELECT number,customer_id,period_start,subtotal,discount_total,tax_total,total,amount_paid,status,due_date FROM invoices',
      payments: 'SELECT invoice_id,method,amount,date,note FROM payments',
      subscriptions: 'SELECT number,customer_id,plan_id,status,start_date,expiry_date,next_billing FROM subscriptions' }[q.params.type];
    if (!sql) return r.status(404).end();
    const rows = db.prepare(sql).all(), cols = rows.length ? Object.keys(rows[0]) : [];
    const e = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    r.type('text/csv').send([cols.join(','), ...rows.map(x => cols.map(c => e(x[c])).join(','))].join('\n'));
  });

  // ---------- Customer portal API ----------
  const mine = auth('customer');
  app.get('/api/my/summary', mine, (q, r) => {
    const id = q.user.id;
    r.json({
      active: db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE customer_id=? AND status='Active'").get(id).c,
      next_renewal: db.prepare("SELECT MIN(next_billing) d FROM subscriptions WHERE customer_id=? AND status='Active' AND paused=0").get(id).d,
      outstanding: db.prepare("SELECT COALESCE(SUM(total-amount_paid),0) s FROM invoices WHERE customer_id=? AND status='Confirmed'").get(id).s });
  });
  app.get('/api/my/subs', mine, (q, r) => r.json(db.prepare(
    'SELECT s.*, p.name plan_name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=? ORDER BY s.id DESC').all(q.user.id)));
  app.get('/api/my/subs/:id', mine, (q, r) => {
    const s = subDetail(q.params.id);
    s && s.customer_id === q.user.id ? r.json(s) : r.status(404).json({ error: 'Subscription not found' });
  });
  app.post('/api/my/subs/:id/action', mine, (q, r) => {
    const s = subDetail(q.params.id);
    if (!s || s.customer_id !== q.user.id) return r.status(404).json({ error: 'Subscription not found' });
    const a = q.body.action;
    if (a === 'close' && s.closable && s.status === 'Active')
      db.prepare("UPDATE subscriptions SET status='Closed' WHERE id=?").run(s.id);
    else if (a === 'pause' && s.pausable && s.status === 'Active')
      db.prepare('UPDATE subscriptions SET paused=1-paused WHERE id=?').run(s.id);
    else if (a === 'renew' && s.renewable && ['Active', 'Closed'].includes(s.status)) {
      const base = s.expiry_date && s.expiry_date > today() ? s.expiry_date : today();
      db.prepare("UPDATE subscriptions SET expiry_date=?, next_billing=CASE WHEN status='Closed' THEN ? ELSE next_billing END, status='Active' WHERE id=?")
        .run(addPeriod(base, s.period), today(), s.id);
    } else return r.status(400).json({ error: 'This plan or status does not allow that action' });
    db.audit('subscription', s.id, 'Customer: ' + a, q.user.id);
    r.json({ ok: true });
  });
  app.get('/api/my/invoices/:id', mine, (q, r) => {
    const i = invDetail(q.params.id);
    i && i.customer_id === q.user.id ? r.json(i) : r.status(404).json({ error: 'Invoice not found' });
  });
  app.get('/api/my/payments', mine, (q, r) => r.json(db.prepare(`SELECT p.*, i.number invoice_number FROM payments p
    JOIN invoices i ON i.id=p.invoice_id WHERE i.customer_id=? ORDER BY p.id DESC`).all(q.user.id)));
  app.get('/api/my/profile', auth(), (q, r) => r.json(db.prepare('SELECT id,name,email,company,phone,address FROM users WHERE id=?').get(q.user.id)));
  app.put('/api/my/profile', auth(), (q, r) => {
    const { name, company, phone, address } = q.body;
    db.prepare('UPDATE users SET name=?,company=?,phone=?,address=? WHERE id=?').run(name, company || null, phone || null, address || null, q.user.id);
    r.json({ ok: true });
  });
  app.post('/api/my/password', auth(), (q, r) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(q.user.id);
    if (!bcrypt.compareSync(q.body.old || '', u.password_hash)) return r.status(400).json({ error: 'Current password is wrong' });
    if (!pwRule.test(q.body.new || '')) return r.status(400).json({ error: PWMSG });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(q.body.new, 10), u.id);
    r.json({ ok: true });
  });
};