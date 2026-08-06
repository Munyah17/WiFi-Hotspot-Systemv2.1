const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');

const router = express.Router();

function toSessionUser(row) {
  return { id: row.id, phone_number: row.phone_number, full_name: row.full_name, role: row.role };
}

// Customers self-register from the portal. Staff/admin accounts are created
// by an admin (see routes/admin.js) — there's no public signup for those roles.
router.post('/register', (req, res) => {
  const { phone_number, password, full_name } = req.body;
  if (!phone_number || !password) return res.status(400).json({ error: 'Phone number and password are required' });

  const existing = db.prepare('SELECT id FROM users WHERE phone_number = ?').get(phone_number);
  if (existing) return res.status(409).json({ error: 'An account with this phone number already exists' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare('INSERT INTO users (phone_number, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
    .run(phone_number, hash, full_name || null, 'customer');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  req.session.user = toSessionUser(user);
  res.json({ user: req.session.user });
});

router.post('/login', (req, res) => {
  const { phone_number, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phone_number);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid phone number or password' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'Account is suspended' });

  req.session.user = toSessionUser(user);
  res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

module.exports = router;
