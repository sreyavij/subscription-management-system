const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), db = require('./db');
const SECRET = 'change-me';
const pwRule = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{9,}$/;

exports.signup = (req, res) => {
  const { name, email, password } = req.body;
  if (!pwRule.test(password)) return res.status(400).json({ error: 'Password must be 9+ chars with upper, lower and special character' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(400).json({ error: 'Email already registered' });
  db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name, email, bcrypt.hashSync(password, 10));
  res.json({ ok: true });
};
exports.login = (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email);
  if (!u || !bcrypt.compareSync(req.body.password, u.password_hash)) return res.status(401).json({ error: 'Invalid login' });
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '1d' }), role: u.role });
};
exports.auth = (...roles) => (req, res, next) => {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch { res.status(401).json({ error: 'Login required' }); }
};