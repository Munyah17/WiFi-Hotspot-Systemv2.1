const express = require('express');
const db = require('../services/db');
const vouchers = require('../services/vouchers');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('cashier', 'admin'));

// Cash sale: staff accepts physical cash, prints a voucher for the customer
// to redeem themselves on the portal (keeps activation logic in one place).
router.post('/vouchers', (req, res) => {
  try {
    const { packageId } = req.body;
    const voucher = vouchers.issueVoucher({
      packageId,
      issueReason: 'cash',
      createdByUserId: req.session.user.id,
    });
    db.prepare(
      `INSERT INTO sales (transaction_type, payment_method, amount, cashier_id, voucher_id) VALUES ('voucher', 'cash', ?, ?, ?)`
    ).run(voucher.price, req.session.user.id, voucher.id);
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

router.get('/customers/search', (req, res) => {
  const q = `%${req.query.phone || ''}%`;
  const results = db
    .prepare("SELECT id, phone_number, full_name, loyalty_points, status FROM users WHERE role = 'customer' AND phone_number LIKE ?")
    .all(q);
  res.json(results);
});

module.exports = router;
