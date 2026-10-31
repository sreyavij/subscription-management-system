const db = require('./db');

const addPeriod = (d, p) => {
  const x = new Date(d);
  if (p === 'daily') x.setUTCDate(x.getUTCDate() + 1);
  else if (p === 'weekly') x.setUTCDate(x.getUTCDate() + 7);
  else if (p === 'monthly') x.setUTCMonth(x.getUTCMonth() + 1);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x.toISOString().slice(0, 10);
};
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const r2 = n => Math.round(n * 100) / 100;

// Best single discount for a line (no stacking)
function bestDiscount(line, gross, date) {
  const rows = db.prepare(`SELECT * FROM discounts WHERE (product_id IS NULL OR product_id=?)
    AND (start_date IS NULL OR start_date<=?) AND (end_date IS NULL OR end_date>=?)
    AND (usage_limit IS NULL OR used_count<usage_limit) AND min_qty<=? AND min_amount<=?`)
    .all(line.product_id, date, date, line.qty, gross);
  let best = { id: null, amt: 0 };
  for (const d of rows) {
    const amt = d.type === 'percent' ? gross * d.value / 100 : Math.min(d.value, gross);
    if (amt > best.amt) best = { id: d.id, amt: r2(amt) };
  }
  return best;
}

const billOne = db.transaction((s, start, next) => {
  const advance = () => db.prepare('UPDATE subscriptions SET next_billing=? WHERE id=?').run(next, s.id);
  if (db.prepare('SELECT 1 FROM invoices WHERE sub_id=? AND period_start=?').get(s.id, start)) { advance(); return false; }

  const lines = db.prepare(`SELECT l.*, p.name, t.rate FROM sub_lines l
    JOIN products p ON p.id=l.product_id LEFT JOIN taxes t ON t.id=l.tax_id WHERE l.sub_id=?`).all(s.id);
  const inv = db.prepare('INSERT INTO invoices(number,sub_id,customer_id,period_start,due_date) VALUES(?,?,?,?,?)')
    .run(`INV-${s.id}-${start}`, s.id, s.customer_id, start, addDays(start, (db.prepare('SELECT days FROM payment_terms WHERE name=?').get(s.payment_terms) || { days: 15 }).days));

  let sub = 0, disc = 0, tax = 0;
  for (const l of lines) {
    const gross = r2(l.qty * l.unit_price);
    const d = bestDiscount(l, gross, start);
    const t = r2((gross - d.amt) * (l.rate || 0) / 100);
    sub += gross; disc += d.amt; tax += t;
    db.prepare('INSERT INTO invoice_lines(invoice_id,description,qty,unit_price,discount,tax,amount) VALUES(?,?,?,?,?,?,?)')
      .run(inv.lastInsertRowid, l.name, l.qty, l.unit_price, d.amt, t, r2(gross - d.amt + t));
    if (d.id) db.prepare('UPDATE discounts SET used_count=used_count+1 WHERE id=?').run(d.id);
  }
  db.prepare('UPDATE invoices SET subtotal=?,discount_total=?,tax_total=?,total=? WHERE id=?')
    .run(r2(sub), r2(disc), r2(tax), r2(sub - disc + tax), inv.lastInsertRowid);
  advance();
  return true;
});

function runBilling(today = new Date().toISOString().slice(0, 10)) {
  let created = 0;
  const subs = db.prepare(`SELECT s.*, p.period, p.auto_close FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id WHERE s.status='Active' AND s.paused=0 AND s.next_billing<=?`).all(today);
  for (const s of subs) {
    let cur = s.next_billing;
    while (cur <= today && (!s.expiry_date || cur <= s.expiry_date)) {   // catches up missed periods
      const next = addPeriod(cur, s.period);
      if (billOne(s, cur, next)) created++;
      cur = next;
    }
    if (s.auto_close && s.expiry_date && cur > s.expiry_date)
      db.prepare("UPDATE subscriptions SET status='Closed' WHERE id=?").run(s.id);
  }
  return created;
}
module.exports = { runBilling };