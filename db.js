const Database = require('better-sqlite3');
const db = new Database('app.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE,
  password_hash TEXT, role TEXT DEFAULT 'customer', reset_token TEXT, reset_expiry INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT, type TEXT,
  sales_price REAL, cost_price REAL, notes TEXT);
CREATE TABLE IF NOT EXISTS variants(id INTEGER PRIMARY KEY, product_id INT, attribute TEXT,
  value TEXT, extra_price REAL);
CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY, name TEXT, price REAL,
  period TEXT, min_qty INT DEFAULT 1, start_date TEXT, end_date TEXT,
  auto_close INT, closable INT, pausable INT, renewable INT);
CREATE TABLE IF NOT EXISTS taxes(id INTEGER PRIMARY KEY, name TEXT, rate REAL);
CREATE TABLE IF NOT EXISTS discounts(id INTEGER PRIMARY KEY, name TEXT, type TEXT, value REAL,
  min_amount REAL DEFAULT 0, min_qty INT DEFAULT 0, start_date TEXT, end_date TEXT,
  usage_limit INT, used_count INT DEFAULT 0, product_id INT);
CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY, number TEXT, customer_id INT,
  plan_id INT, start_date TEXT, expiry_date TEXT, payment_terms TEXT,
  status TEXT DEFAULT 'Draft', next_billing TEXT, paused INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS sub_lines(id INTEGER PRIMARY KEY, sub_id INT, product_id INT,
  variant_id INT, qty INT, unit_price REAL, tax_id INT);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT, sub_id INT,
  customer_id INT, period_start TEXT, subtotal REAL, discount_total REAL, tax_total REAL,
  total REAL, amount_paid REAL DEFAULT 0, status TEXT DEFAULT 'Draft', due_date TEXT,
  UNIQUE(sub_id, period_start));
CREATE TABLE IF NOT EXISTS invoice_lines(id INTEGER PRIMARY KEY, invoice_id INT,
  description TEXT, qty INT, unit_price REAL, discount REAL, tax REAL, amount REAL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, invoice_id INT, method TEXT,
  amount REAL, date TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS i1 ON subscriptions(status, next_billing);
CREATE INDEX IF NOT EXISTS i2 ON invoices(status, due_date);
`);

for (const c of ['company', 'phone', 'address']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`); } catch {} }
for (const [t, c] of [['subscriptions', 'valid_until TEXT'], ['subscriptions', 'template_id INT'], ['invoices', 'sent_at TEXT']]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch {}
}
db.exec(`
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, entity TEXT, entity_id INT, action TEXT, user_id INT, at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY, name TEXT, validity_days INT, plan_id INT);
CREATE TABLE IF NOT EXISTS template_lines(id INTEGER PRIMARY KEY, template_id INT, product_id INT, variant_id INT, qty INT, tax_id INT);
CREATE TABLE IF NOT EXISTS payment_terms(id INTEGER PRIMARY KEY, name TEXT, days INT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);
if (!db.prepare('SELECT 1 FROM payment_terms').get()) {
  const ins = db.prepare('INSERT INTO payment_terms(name,days) VALUES(?,?)');
  ins.run('Immediate', 0); ins.run('Net 15', 15); ins.run('Net 30', 30);
}
db.audit = (entity, id, action, uid) =>
  db.prepare('INSERT INTO audit_log(entity,entity_id,action,user_id) VALUES(?,?,?,?)').run(entity, id, action, uid || null);

module.exports = db;