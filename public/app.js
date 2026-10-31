const T = localStorage.getItem('token'), ROLE = localStorage.getItem('role');
if (!T) location.href = '/';
const ME = (() => { try { return JSON.parse(atob(T.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch { return 0; } })();
const $ = id => document.getElementById(id);
const arr = x => Array.isArray(x) ? x : [];
const today = () => new Date().toISOString().slice(0, 10);
const money = v => Number(v || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const logout = () => { localStorage.clear(); location.href = '/'; };
const go = p => { location.hash = '#/' + p; };
const say = (t, bad) => { const m = $('msg'); if (m) { m.style.color = bad ? 'var(--bad)' : 'var(--ok)'; m.textContent = t; } };
const api = (u, m = 'GET', b) => fetch('/api/' + u, {
  method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T },
  body: b ? JSON.stringify(b) : undefined
}).then(r => r.json()).then(d => { if (d && d.error === 'Login required') logout(); return d; });

// ----- rendering helpers -----
const html = s => ({ html: s });
const pill = s => html(`<span class="pill ${esc(s)}">${esc(s)}</span>`);
const STEPS = ['Draft', 'Quotation', 'Confirmed', 'Active', 'Closed'];
const stepper = s => html(`<span class="steps">${STEPS.map((_, i) => `<i class="${i <= STEPS.indexOf(s) ? 'done' : ''}"></i>`).join('')}<span>${esc(s)}</span></span>`);
const MONEY = ['subtotal', 'discount_total', 'tax_total', 'total', 'amount_paid', 'amount', 'owed', 'unit_price', 'sales_price', 'cost_price', 'price', 'extra_price', 'discount', 'tax'];
const cell = (c, v) => {
  if (v && v.html !== undefined) return v.html;
  if (v == null) return '';
  if (c === 'status') return pill(v).html;
  if (MONEY.includes(c)) return money(v);
  if (c === 'paused') return v ? 'Paused' : '';
  return esc(v);
};
const table = (rows, cols, act) => {
  if (rows && rows.error) return `<p class="err">${esc(rows.error)}</p>`;
  if (!arr(rows).length) return '<p class="empty">Nothing here yet.</p>';
  return '<table><tr>' + cols.map(c => `<th>${c.replace(/_/g, ' ')}</th>`).join('') + (act ? '<th></th>' : '') + '</tr>' +
    rows.map(r => '<tr>' + cols.map(c => `<td>${cell(c, r[c])}</td>`).join('') + (act ? `<td>${act(r)}</td>` : '') + '</tr>').join('') + '</table>';
};
const kpi = (l, v, c = '') => `<div class="card ${c}">${l}<b>${v}</b></div>`;
const bars = (rows, k, v) => {
  rows = arr(rows);
  if (!rows.length) return '<p class="empty">No data for these filters.</p>';
  const max = Math.max(1, ...rows.map(r => r[v]));
  return '<div class="chart">' + rows.map(r => `<div class="col"><em>${money(r[v])}</em><div style="height:${Math.max(2, Math.round(r[v] / max * 120))}px"></div><span>${esc(r[k])}</span></div>`).join('') + '</div>';
};

// ----- forms -----
const F = (n, t = 'text', x = {}) => ({ n, t, ...x });
const YN = [['1', 'Yes'], ['0', 'No']];
let REF = {};
const REFURL = { products: 'products', variants: 'variants', plans: 'plans', taxes: 'taxes', clients: 'clients', terms: 'terms' };
const loadRefs = async names => { await Promise.all([...new Set(names)].map(async n => { REF[n] = await api(REFURL[n]); })); };
const opts = (rows, label, key = 'id', none = false) =>
  (none ? `<option value="">${none === true ? '(none)' : none}</option>` : '') +
  arr(rows).map(r => `<option value="${esc(r[key])}">${label(r)}</option>`).join('');
const formHTML = fields => fields.map(f => {
  const inner = f.t !== 'select' ? '' : f.src
    ? opts(REF[f.src], r => esc(r.name), 'id', f.optional ? '(none)' : false)
    : f.opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  return `<label>${f.l || f.n.replace(/_/g, ' ')}</label>` +
    (f.t === 'select' ? `<select id="f_${f.n}">${inner}</select>` : `<input id="f_${f.n}" type="${f.t}">`);
}).join('');
const readForm = fields => Object.fromEntries(fields.map(f => {
  let v = $('f_' + f.n).value;
  v = v === '' ? null : (f.t === 'number' || (f.t === 'select' && !isNaN(v))) ? Number(v) : v;
  return [f.n, v];
}));