const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const mikrotik = require('../services/mikrotik');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/router/status', async (req, res) => {
  res.json({ connected: await mikrotik.testConnection() });
});

router.get('/network/active', async (req, res) => {
  try {
    res.json(await mikrotik.getActiveUsers());
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router' });
  }
});

router.post('/network/kick/:mac', async (req, res) => {
  try {
    await mikrotik.kickActiveSessionByMac(req.params.mac);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach the router' });
  }
});

router.get('/revenue/today', (req, res) => {
  const rows = db
    .prepare(
      `SELECT payment_method, SUM(amount) AS total, COUNT(*) AS count FROM sales
       WHERE date(timestamp) = date('now') GROUP BY payment_method`
    )
    .all();
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  res.json({ total, byMethod: rows });
});

// --- Packages ---

router.get('/packages', (req, res) => {
  res.json(db.prepare('SELECT * FROM packages ORDER BY price ASC').all());
});

router.post('/packages', (req, res) => {
  const { name, duration_seconds, price } = req.body;
  const result = db
    .prepare('INSERT INTO packages (name, duration_seconds, price) VALUES (?, ?, ?)')
    .run(name, duration_seconds, price);
  res.json(db.prepare('SELECT * FROM packages WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/packages/:id', (req, res) => {
  const { name, duration_seconds, price, active } = req.body;
  db.prepare('UPDATE packages SET name = ?, duration_seconds = ?, price = ?, active = ? WHERE id = ?').run(
    name,
    duration_seconds,
    price,
    active ? 1 : 0,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id));
});

// --- Staff management ---

router.get('/staff', (req, res) => {
  res.json(
    db.prepare("SELECT id, phone_number, full_name, role, status, created_at FROM users WHERE role IN ('admin', 'cashier')").all()
  );
});

router.post('/staff', (req, res) => {
  const { phone_number, password, full_name, role } = req.body;
  if (!['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Role must be admin or cashier' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db
      .prepare('INSERT INTO users (phone_number, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
      .run(phone_number, hash, full_name || null, role);
    res.json(db.prepare('SELECT id, phone_number, full_name, role, status FROM users WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    res.status(409).json({ error: 'A user with this phone number already exists' });
  }
});

router.put('/staff/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// --- Customers ---

router.get('/customers', (req, res) => {
  res.json(db.prepare("SELECT id, phone_number, full_name, loyalty_points, status, created_at FROM users WHERE role = 'customer'").all());
});

// --- Inventory (shop) ---

router.get('/inventory', (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory ORDER BY item_name ASC').all());
});

router.post('/inventory', (req, res) => {
  const { item_name, price, stock_quantity } = req.body;
  const result = db
    .prepare('INSERT INTO inventory (item_name, price, stock_quantity) VALUES (?, ?, ?)')
    .run(item_name, price, stock_quantity || 0);
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(result.lastInsertRowid));
});

module.exports = router;
