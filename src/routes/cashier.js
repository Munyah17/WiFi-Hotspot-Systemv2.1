const express = require('express');
const db = require('../services/db');
const vouchers = require('../services/vouchers');
const loyalty = require('../services/loyalty');
const audit = require('../services/audit');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('cashier', 'admin'));

function getOpenShift(cashierId) {
  return db.prepare("SELECT * FROM shifts WHERE cashier_id = ? AND status = 'open'").get(cashierId);
}

// --- Shift management ---

router.get('/shift/current', (req, res) => {
  const shift = getOpenShift(req.session.user.id);
  if (!shift) return res.json({ shift: null });
  const totals = db
    .prepare(
      `SELECT payment_method, SUM(amount) AS total, COUNT(*) AS count FROM sales
       WHERE shift_id = ? GROUP BY payment_method`
    )
    .all(shift.id);
  const cashTotal = totals.find((t) => t.payment_method === 'cash')?.total || 0;
  res.json({ shift, totals, expectedCash: shift.opening_float + cashTotal });
});

router.post('/shift/open', (req, res) => {
  if (getOpenShift(req.session.user.id)) return res.status(409).json({ error: 'A shift is already open' });
  const openingFloat = Number(req.body.openingFloat) || 0;
  const result = db
    .prepare('INSERT INTO shifts (cashier_id, opening_float) VALUES (?, ?)')
    .run(req.session.user.id, openingFloat);
  audit.logAction(req.session.user.id, 'shift_open', 'shift', result.lastInsertRowid, { openingFloat });
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(result.lastInsertRowid));
});

router.post('/shift/close', (req, res) => {
  const shift = getOpenShift(req.session.user.id);
  if (!shift) return res.status(404).json({ error: 'No open shift' });
  const closingCounted = Number(req.body.closingCounted) || 0;
  db.prepare("UPDATE shifts SET status = 'closed', closing_counted = ?, closed_at = datetime('now') WHERE id = ?").run(
    closingCounted,
    shift.id
  );
  audit.logAction(req.session.user.id, 'shift_close', 'shift', shift.id, { closingCounted });
  res.json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id));
});

// --- Cash voucher sale ---

// Cash sale: staff accepts physical cash, prints a voucher for the customer
// to redeem themselves on the portal (keeps activation logic in one place).
router.post('/vouchers', (req, res) => {
  try {
    const { packageId } = req.body;
    const shift = getOpenShift(req.session.user.id);
    const voucher = vouchers.issueVoucher({
      packageId,
      issueReason: 'cash',
      createdByUserId: req.session.user.id,
    });
    db.prepare(
      `INSERT INTO sales (transaction_type, payment_method, amount, cashier_id, shift_id, voucher_id) VALUES ('voucher', 'cash', ?, ?, ?, ?)`
    ).run(voucher.price, req.session.user.id, shift?.id || null, voucher.id);
    audit.logAction(req.session.user.id, 'issue_voucher_cash', 'voucher', voucher.id, { code: voucher.code, price: voucher.price });
    res.json({ voucher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/vouchers/recent', (req, res) => {
  const recent = db
    .prepare(
      `SELECT v.*, p.name AS package_name FROM vouchers v
       JOIN packages p ON p.id = v.package_id
       WHERE v.created_by_user_id = ? ORDER BY v.created_at DESC LIMIT 20`
    )
    .all(req.session.user.id);
  res.json(recent);
});

// --- Customer lookup & management ---

router.get('/customers/search', (req, res) => {
  const q = `%${req.query.phone || ''}%`;
  const results = db
    .prepare("SELECT id, phone_number, full_name, loyalty_points, status FROM users WHERE role = 'customer' AND phone_number LIKE ?")
    .all(q);
  res.json(results);
});

router.get('/customers/:id', (req, res) => {
  const customer = db
    .prepare("SELECT id, phone_number, full_name, loyalty_points, status, created_at FROM users WHERE id = ? AND role = 'customer'")
    .get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(customer.id);
  const voucherHistory = db
    .prepare(
      `SELECT v.*, s.status AS session_status FROM vouchers v
       LEFT JOIN sessions_log s ON s.voucher_id = v.id
       WHERE v.issued_to_user_id = ? ORDER BY v.created_at DESC LIMIT 20`
    )
    .all(customer.id);

  res.json({ customer, devices, voucherHistory });
});

router.post('/customers/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  audit.logAction(req.session.user.id, 'customer_status_change', 'user', req.params.id, { status });
  res.json({ ok: true });
});

// If the customer has a session running right now, this adds time straight
// onto it via the router API. Otherwise it credits a voucher to their
// account for them to redeem later via the portal.
router.post('/customers/:id/extend', async (req, res) => {
  try {
    const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { packageId, paymentMethod = 'cash' } = req.body;
    const { voucher, mode, mikrotikUsername } = await vouchers.topUpUser({
      userId: customer.id,
      packageId,
      createdByUserId: req.session.user.id,
    });
    const shift = getOpenShift(req.session.user.id);
    db.prepare(
      `INSERT INTO sales (transaction_type, payment_method, amount, cashier_id, shift_id, voucher_id, user_id) VALUES ('voucher', ?, ?, ?, ?, ?, ?)`
    ).run(paymentMethod, voucher.price, req.session.user.id, shift?.id || null, voucher.id, customer.id);
    loyalty.awardForSale(customer.id);
    audit.logAction(req.session.user.id, 'extend_access', 'user', customer.id, { code: voucher.code, packageId, mode });
    res.json({ voucher, mode, mikrotikUsername });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/customers/:id/loyalty', (req, res) => {
  const customer = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'customer'").get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const delta = Number(req.body.delta) || 0;
  loyalty.adjust(customer.id, delta);
  audit.logAction(req.session.user.id, 'loyalty_adjust', 'user', customer.id, { delta });
  res.json(db.prepare('SELECT loyalty_points FROM users WHERE id = ?').get(customer.id));
});

module.exports = router;
