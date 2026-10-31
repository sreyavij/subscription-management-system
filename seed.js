// Demo data for Brightloop.
//   node seed.js              add demo data (only if the database is empty)
//   node seed.js --reset      wipe products, plans, invoices, customers and staff, then add demo data
//   node seed.js --bulk 5000  also add 5000 extra subscriptions to test page speed
const bcrypt = require('bcryptjs');
const db = require('./db');
const { runBilling } = require('./billing');
const has = f => process.argv.includes(f);

// Dates are relative to today, so the demo always has overdue invoices, renewals and so on
const iso = x => x.toISOString().slice(0, 10);
const day = n => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const month = n => { const x = new Date(), d = Math.min(x.getUTCDate(), 28); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); x.setUTCDate(d); return iso(x); };
const plus = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const TODAY = day(0);
const early = d => (d < TODAY ? d : TODAY);
const METHODS = ['UPI', 'Card', 'Bank transfer', 'Cash'];
const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);

function wipe() {
  for (const t of ['payments', 'invoice_lines', 'invoices', 'sub_lines', 'subscriptions', 'template_lines', 'templates',
    'discounts', 'variants', 'products', 'plans', 'taxes', 'audit_log', 'settings']) db.exec(`DELETE FROM ${t}`);
  db.exec("DELETE FROM users WHERE role IN ('customer','staff')");
  console.log('Old business data, customers and staff removed.');
}

function demo() {
  const pw = bcrypt.hashSync('Customer@12345', 10), spw = bcrypt.hashSync('Staff@12345', 10);
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get())
    db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES('Admin','admin@brightloop.com',?,'admin')").run(bcrypt.hashSync('Admin@12345', 10));
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id").get().id;

  // Company settings
  const st = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  Object.entries({
    company_name: 'Brightloop Software', address: 'Infopark Road, Kochi, Kerala 682042', email: 'billing@brightloop.example',
    phone: '+91 484 000 0000', tax_id: 'GSTIN 00AAAAA0000A1Z0', invoice_footer: 'Thank you for your business. Payment is due as per the terms above.',
    methods: 'UPI,Card,Cash,Bank transfer', gateway: 'Demo gateway (payments are recorded manually)'
  }).forEach(([k, v]) => st.run(k, v));

  // Taxes
  const gst18 = ins('INSERT INTO taxes(name,rate) VALUES(?,?)', 'GST 18%', 18);
  const gst5 = ins('INSERT INTO taxes(name,rate) VALUES(?,?)', 'GST 5%', 5);

  // Products and variants
  const P = {};
  for (const [k, name, type, sale, cost, notes] of [
    ['crm', 'CRM Suite', 'Software', 1000, 600, 'Customer relationship management'],
    ['acc', 'Accounting Pro', 'Software', 1500, 800, 'Invoicing, ledgers and reports'],
    ['help', 'Helpdesk Cloud', 'Software', 800, 450, 'Ticketing and live chat'],
    ['store', 'Extra Storage', 'Add-on', 200, 80, 'Additional 100 GB'],
    ['sup', 'Priority Support', 'Add-on', 500, 250, 'Round-the-clock priority support'],
    ['ana', 'Analytics Module', 'Add-on', 700, 300, 'Dashboards and exports']])
    P[k] = ins('INSERT INTO products(name,type,sales_price,cost_price,notes) VALUES(?,?,?,?,?)', name, type, sale, cost, notes);
  const V = {};
  for (const [k, prod, attr, val, extra] of [
    ['odoo', 'crm', 'Brand', 'Odoo', 560], ['zoho', 'crm', 'Brand', 'Zoho', 300], ['sf', 'crm', 'Brand', 'Salesforce', 900],
    ['std', 'acc', 'Edition', 'Standard', 0], ['ent', 'acc', 'Edition', 'Enterprise', 1200],
    ['s10', 'help', 'Seats', '10 seats', 0], ['s50', 'help', 'Seats', '50 seats', 1500]])
    V[k] = ins('INSERT INTO variants(product_id,attribute,value,extra_price) VALUES(?,?,?,?)', P[prod], attr, val, extra);

  // Plans
  const PL = {};
  for (const [k, name, price, period, minq, start, end, auto, close, pause, renew] of [
    ['month', 'Starter Monthly', 500, 'monthly', 1, '2026-01-01', '2027-12-31', 0, 1, 1, 1],
    ['year', 'Business Yearly', 5000, 'yearly', 1, '2026-01-01', '2028-12-31', 0, 0, 0, 1],
    ['week', 'Weekly Trial', 100, 'weekly', 1, '2026-01-01', '2027-06-30', 1, 1, 1, 0],
    ['dayp', 'Daily Pass', 20, 'daily', 1, '2026-01-01', '2027-12-31', 0, 0, 0, 0]])
    PL[k] = ins('INSERT INTO plans(name,price,period,min_qty,start_date,end_date,auto_close,closable,pausable,renewable) VALUES(?,?,?,?,?,?,?,?,?,?)',
      name, price, period, minq, start, end, auto, close, pause, renew);

  // Discounts (one of them is already expired)
  const D = db.prepare('INSERT INTO discounts(name,type,value,min_amount,min_qty,start_date,end_date,usage_limit,product_id) VALUES(?,?,?,?,?,?,?,?,?)');
  D.run('Volume discount 10% (5+ seats)', 'percent', 10, 0, 5, '2026-01-01', '2027-12-31', 50, null);
  D.run('Flat 500 off large orders', 'fixed', 500, 5000, 0, '2026-01-01', '2027-12-31', 20, null);
  D.run('CRM launch offer 15%', 'percent', 15, 0, 0, month(-2), month(2), 10, P.crm);
  D.run('Summer sale 20% (expired)', 'percent', 20, 0, 0, '2026-04-01', '2026-06-30', 100, null);

  // Staff and customers
  const staff1 = ins("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'staff')", 'Priya Staff', 'staff@brightloop.com', spw);
  const staff2 = ins("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'staff')", 'Manu Staff', 'manu@brightloop.com', spw);
  const CITY = ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur'];
  const C = [
    ['Asha Menon', 'Menon Textiles', 'asha@menontextiles.example'], ['Rahul Nair', 'Nair Traders', 'rahul@nairtraders.example'],
    ['Fathima Noor', 'Noor Bakery', 'fathima@noorbakery.example'], ['Vishnu Kumar', 'Kumar Logistics', 'vishnu@kumarlogistics.example'],
    ['Divya Thomas', 'Thomas Dental Clinic', 'divya@thomasdental.example'], ['Arjun Pillai', 'Pillai Constructions', 'arjun@pillaiconstructions.example'],
    ['Meera Iyer', 'Iyer Analytics Pvt Ltd', 'meera@iyeranalytics.example'], ['Joseph Mathew', 'Mathew and Sons Hardware', 'joseph@mathewhardware.example'],
    ['Sneha Rao', 'Rao Learning Hub', 'sneha@raolearning.example'], ['Kiran Das', 'Das Freight Services', 'kiran@dasfreight.example']
  ].map(([name, company, email], i) => ins("INSERT INTO users(name,email,password_hash,role,company,phone,address) VALUES(?,?,?,'customer',?,?,?)",
    name, email, pw, company, '+91 90000 0000' + i, CITY[i % 4] + ', Kerala'));

  // Quotation templates
  const tl = db.prepare('INSERT INTO template_lines(template_id,product_id,variant_id,qty,tax_id) VALUES(?,?,?,?,?)');
  const tp = ins('INSERT INTO templates(name,validity_days,plan_id) VALUES(?,?,?)', 'Starter CRM bundle', 30, PL.month);
  tl.run(tp, P.crm, V.odoo, 1, gst18); tl.run(tp, P.sup, null, 1, gst18);
  const te = ins('INSERT INTO templates(name,validity_days,plan_id) VALUES(?,?,?)', 'Enterprise suite', 45, PL.year);
  tl.run(te, P.crm, V.zoho, 10, gst18); tl.run(te, P.acc, V.ent, 5, gst18); tl.run(te, P.ana, null, 5, gst18);

  // Subscriptions
  const price = (p, v) => db.prepare('SELECT sales_price FROM products WHERE id=?').get(p).sales_price +
    (v ? db.prepare('SELECT extra_price FROM variants WHERE id=?').get(v).extra_price : 0);
  let n = 0;
  const sub = (cust, plan, status, start, expiry, terms, lines, extra = {}) => {
    const id = ins(`INSERT INTO subscriptions(number,customer_id,plan_id,start_date,expiry_date,payment_terms,status,next_billing,valid_until,template_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, 'SUB-2026-' + String(++n).padStart(4, '0'), cust, plan, start, expiry, terms, status,
      status === 'Active' ? start : null, extra.valid || null, extra.tpl || null);
    for (const [p, v, q, t] of lines)
      db.prepare('INSERT INTO sub_lines(sub_id,product_id,variant_id,qty,unit_price,tax_id) VALUES(?,?,?,?,?,?)').run(id, p, v, q, price(p, v), t);
    return id;
  };
  const s1 = sub(C[0], PL.month, 'Active', month(-3), month(9), 'Net 15', [[P.crm, V.odoo, 2, gst18]]);
  const s2 = sub(C[1], PL.month, 'Active', month(-2), month(10), 'Net 30', [[P.acc, V.std, 1, gst18], [P.store, null, 3, gst18]]);
  const s3 = sub(C[2], PL.week, 'Active', day(-21), '2027-06-30', 'Immediate', [[P.help, V.s10, 1, gst5]]);
  const s4 = sub(C[3], PL.year, 'Active', month(-14), month(10), 'Net 30', [[P.crm, V.sf, 10, gst18]]);
  const s5 = sub(C[4], PL.month, 'Quotation', day(5), month(12), 'Net 15', [[P.crm, V.odoo, 1, gst18], [P.sup, null, 1, gst18]], { valid: day(20), tpl: tp });
  const s6 = sub(C[5], PL.month, 'Draft', day(10), null, 'Net 15', [[P.ana, null, 2, gst18]]);
  const s7 = sub(C[6], PL.year, 'Active', month(-2), month(10), 'Net 30', [[P.acc, V.ent, 8, gst18], [P.ana, null, 8, gst18]]);
  const s8 = sub(C[7], PL.month, 'Active', month(-6), month(-1), 'Net 15', [[P.help, V.s50, 1, gst18]]);   // closed after billing
  const s9 = sub(C[8], PL.month, 'Active', month(-2), month(10), 'Net 15', [[P.store, null, 5, gst18]]);   // paused after billing
  const s10 = sub(C[9], PL.week, 'Confirmed', day(7), '2027-06-30', 'Immediate', [[P.sup, null, 2, gst5]]);
  const s11 = sub(C[2], PL.dayp, 'Active', day(-2), month(1), 'Immediate', [[P.store, null, 1, gst5]]);

  // Audit trail
  const aud = (id, action, uid, ago) => db.prepare("INSERT INTO audit_log(entity,entity_id,action,user_id,at) VALUES('subscription',?,?,?,datetime('now',?))")
    .run(id, action, uid, `-${ago} days`);
  for (const id of [s1, s2, s3, s4, s7, s8, s9, s11]) {
    aud(id, 'Draft to Quotation', staff1, 90); aud(id, 'Quotation to Confirmed', staff1, 89); aud(id, 'Confirmed to Active', admin, 88);
  }
  aud(s5, 'Created from template Starter CRM bundle', staff1, 3); aud(s6, 'Created', staff2, 1);
  aud(s10, 'Draft to Quotation', staff2, 5); aud(s10, 'Quotation to Confirmed', staff2, 4);

  // Generate every due invoice with the real billing engine
  runBilling(TODAY);
  db.prepare("UPDATE subscriptions SET status='Closed', next_billing=NULL WHERE id=?").run(s8); aud(s8, 'Customer: close', C[7], 40);
  db.prepare('UPDATE subscriptions SET paused=1 WHERE id=?').run(s9); aud(s9, 'Customer: pause', C[8], 10);

  // Confirm, pay and age the invoices so every report has data
  const latestCutoff = day(-7);
  let k = 0;
  const pay = (inv, amount) => {
    db.prepare('INSERT INTO payments(invoice_id,method,amount,date,note) VALUES(?,?,?,?,?)').run(inv.id, METHODS[k++ % 4], amount, early(plus(inv.period_start, 3)), 'Demo payment');
    db.prepare('UPDATE invoices SET amount_paid=amount_paid+? WHERE id=?').run(amount, inv.id);
  };
  for (const i of db.prepare('SELECT * FROM invoices ORDER BY id').all()) {
    if (i.period_start >= latestCutoff) {           // current cycle: some stay Draft, some are confirmed
      if (i.id % 2) db.prepare("UPDATE invoices SET status='Confirmed' WHERE id=?").run(i.id);
      continue;
    }
    db.prepare("UPDATE invoices SET status='Confirmed', sent_at=CASE WHEN id%2=0 THEN datetime('now') END WHERE id=?").run(i.id);
    const r = i.id % 5;
    if (r <= 2) { pay(i, i.total); db.prepare("UPDATE invoices SET status='Paid' WHERE id=?").run(i.id); }
    else if (r === 3) pay(i, Math.round(i.total * 0.4 * 100) / 100);   // part payment
    // r === 4: unpaid, so it becomes overdue once the due date passes
  }
  const c = t => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  console.log(`Demo data added: ${c('products')} products, ${c('plans')} plans, ${c('subscriptions')} subscriptions, ${c('invoices')} invoices, ${c('payments')} payments.`);
}

function bulk(N) {
  const plans = db.prepare("SELECT id FROM plans WHERE period IN ('monthly','yearly')").all().map(x => x.id);
  const prods = db.prepare('SELECT id, sales_price FROM products').all();
  const tax = db.prepare('SELECT id, rate FROM taxes ORDER BY id').get();
  if (!plans.length || !prods.length) return console.log('Add plans and products first (run: node seed.js --reset).');
  const rnd = n => Math.floor(Math.random() * n);
  const pw = bcrypt.hashSync('Customer@12345', 10);
  const custs = db.prepare("SELECT id FROM users WHERE email LIKE 'bulk%@demo.example'").all().map(x => x.id);
  const base = db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE number LIKE 'SUB-B%'").get().c;
  const insSub = db.prepare('INSERT INTO subscriptions(number,customer_id,plan_id,start_date,expiry_date,payment_terms,status,next_billing) VALUES(?,?,?,?,?,?,?,?)');
  const insLine = db.prepare('INSERT INTO sub_lines(sub_id,product_id,variant_id,qty,unit_price,tax_id) VALUES(?,?,?,?,?,?)');
  const insInv = db.prepare('INSERT INTO invoices(number,sub_id,customer_id,period_start,subtotal,discount_total,tax_total,total,amount_paid,status,due_date) VALUES(?,?,?,?,?,0,?,?,?,?,?)');
  const insIL = db.prepare('INSERT INTO invoice_lines(invoice_id,description,qty,unit_price,discount,tax,amount) VALUES(?,?,?,?,?,?,?)');
  const insPay = db.prepare('INSERT INTO payments(invoice_id,method,amount,date,note) VALUES(?,?,?,?,?)');
  db.transaction(() => {
    while (custs.length < 300) {
      const i = custs.length + 1;
      custs.push(ins("INSERT INTO users(name,email,password_hash,role,company) VALUES(?,?,?,'customer',?)", `Demo Customer ${i}`, `bulk${i}@demo.example`, pw, `Demo Company ${i}`));
    }
    for (let i = 1; i <= N; i++) {
      const num = base + i, cust = custs[rnd(custs.length)], plan = plans[rnd(plans.length)], p = prods[rnd(prods.length)], qty = 1 + rnd(5);
      const roll = rnd(100), status = roll < 78 ? 'Active' : roll < 88 ? 'Closed' : roll < 94 ? 'Quotation' : 'Draft';
      const start = month(-rnd(12));
      const sid = Number(insSub.run('SUB-B' + num, cust, plan, start, month(12), 'Net 15', status, status === 'Active' ? day(1 + rnd(27)) : null).lastInsertRowid);
      insLine.run(sid, p.id, null, qty, p.sales_price, tax ? tax.id : null);
      if (status === 'Active' || status === 'Closed') {
        const gross = qty * p.sales_price, tx = Math.round(gross * (tax ? tax.rate : 0)) / 100, total = gross + tx;
        const r = rnd(100), paid = r < 55, stat = paid ? 'Paid' : r < 80 ? 'Confirmed' : 'Draft';
        const iid = Number(insInv.run('INV-B' + num, sid, cust, start, gross, tx, total, paid ? total : 0, stat, plus(start, 15)).lastInsertRowid);
        insIL.run(iid, 'Subscription charge', qty, p.sales_price, 0, tx, total);
        if (paid) insPay.run(iid, METHODS[rnd(4)], total, early(plus(start, 3)), 'Bulk demo payment');
      }
    }
  })();
  console.log(`Added ${N} extra subscriptions with invoices. Open the Subscriptions and Reports pages and check they load in under 2 seconds.`);
}

const empty = !db.prepare('SELECT 1 FROM products').get();
if (has('--reset')) wipe();
if (has('--reset') || empty) demo();
else if (!has('--bulk')) { console.log('The database already has data. Use "node seed.js --reset" to wipe it and add the demo data again.'); process.exit(0); }
if (has('--bulk')) bulk(+process.argv[process.argv.indexOf('--bulk') + 1] || 5000);
