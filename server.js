const express = require('express'), cors = require('cors'), bcrypt = require('bcryptjs');
const db = require('./db');
const { signup, login, auth } = require('./auth');

const app = express();
app.use(cors(), express.json(), express.static('public'));

// Seed the first admin
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)")
    .run('Admin', 'admin@brightloop.com', bcrypt.hashSync('Admin@12345', 10), 'admin');
}

// Auth
app.post('/api/signup', signup);
app.post('/api/login', login);

// Admin adds staff
app.post('/api/staff', auth('admin'), (req, res) => {
  const { name, email, password } = req.body;
  try {
    db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'staff')")
      .run(name, email, bcrypt.hashSync(password, 10));
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Email already exists' }); }
});

// Quick test route to prove roles work
app.get('/api/me', auth(), (req, res) => res.json(req.user));
require('./routes')(app);
require('./routes2')(app);
app.listen(3000, () => console.log('Running on http://localhost:3000'));