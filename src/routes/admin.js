const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const mikrotik = require('../services/mikrotik');
const audit = require('../services/audit');
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
    audit.logAction(req.session.user.id, 'kick_device', 'device', req.params.mac, null);
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

// --- Sales history / reports ---

const RANGE_CLAUSES = {
  today: "date(timestamp) = date('now')",
  '7d': "timestamp >= datetime('now', '-7 days')",
  '30d': "timestamp >= datetime('now', '-30 days')",
  all: '1=1',
};

router.get('/sales', (req, res) => {
  const clause = RANGE_CLAUSES[req.query.range] || RANGE_CLAUSES.today;
  const rows = db
    .prepare(
      `SELECT sa.*, v.code AS voucher_code, u.phone_number AS cashier_phone, cu.phone_number AS customer_phone
       FROM sales sa
       LEFT JOIN vouchers v ON v.id = sa.voucher_id
       LEFT JOIN users u ON u.id = sa.cashier_id
       LEFT JOIN users cu ON cu.id = sa.user_id
       WHERE ${clause}
       ORDER BY sa.timestamp DESC
       LIMIT 200`
    )
    .all();
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
  res.json({ sales: rows, total });
});

// --- Audit log ---

router.get('/audit-logs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT al.*, u.phone_number AS actor_phone, u.full_name AS actor_name
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ORDER BY al.created_at DESC
       LIMIT 100`
    )
    .all();
  res.json(rows);
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
  audit.logAction(req.session.user.id, 'package_create', 'package', result.lastInsertRowid, { name, price });
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
  audit.logAction(req.session.user.id, 'package_update', 'package', req.params.id, { name, price, active });
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
    audit.logAction(req.session.user.id, 'staff_create', 'user', result.lastInsertRowid, { phone_number, role });
    res.json(db.prepare('SELECT id, phone_number, full_name, role, status FROM users WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    res.status(409).json({ error: 'A user with this phone number already exists' });
  }
});

// Name/role only — not password (that's a separate, more sensitive flow) and
// no hard delete, since staff rows are referenced by past vouchers/sales
// (created_by_user_id) that need to stay attributable. Suspend instead.
router.put('/staff/:id', (req, res) => {
  const { full_name, role } = req.body;
  if (!['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Role must be admin or cashier' });
  const staff = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'cashier')").get(req.params.id);
  if (!staff) return res.status(404).json({ error: 'Staff member not found' });

  db.prepare('UPDATE users SET full_name = ?, role = ? WHERE id = ?').run(full_name || null, role, req.params.id);
  audit.logAction(req.session.user.id, 'staff_update', 'user', req.params.id, { full_name, role });
  res.json(db.prepare('SELECT id, phone_number, full_name, role, status FROM users WHERE id = ?').get(req.params.id));
});

router.put('/staff/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  audit.logAction(req.session.user.id, 'staff_status_change', 'user', req.params.id, { status });
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
  audit.logAction(req.session.user.id, 'inventory_create', 'inventory', result.lastInsertRowid, { item_name });
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/inventory/:id', (req, res) => {
  const { item_name, price, stock_quantity } = req.body;
  db.prepare('UPDATE inventory SET item_name = ?, price = ?, stock_quantity = ? WHERE id = ?').run(
    item_name,
    price,
    stock_quantity,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id));
});

// Records a walk-in accessory sale (charger, cable, earphones, etc.) against inventory.
router.post('/inventory/:id/sell', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.stock_quantity <= 0) return res.status(400).json({ error: 'Out of stock' });

  db.prepare('UPDATE inventory SET stock_quantity = stock_quantity - 1 WHERE id = ?').run(item.id);
  db.prepare(
    `INSERT INTO sales (transaction_type, payment_method, amount, cashier_id) VALUES ('gadget', 'cash', ?, ?)`
  ).run(item.price, req.session.user.id);
  audit.logAction(req.session.user.id, 'inventory_sale', 'inventory', item.id, { item_name: item.item_name, price: item.price });
  res.json({ ok: true });
});

module.exports = router;
