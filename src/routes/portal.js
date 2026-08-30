const express = require('express');
const db = require('../services/db');
const vouchers = require('../services/vouchers');
const paynow = require('../services/payments/paynow');
const stripe = require('../services/payments/stripe');
const loyalty = require('../services/loyalty');
const config = require('../config');

const router = express.Router();

function requesterIp(req) {
  // Direct LAN connections only — no reverse proxy in front of this app.
  return req.socket.remoteAddress.replace('::ffff:', '');
}

function asyncRoute(handler) {
  return (req, res) => handler(req, res).catch((err) => res.status(400).json({ error: err.message }));
}

// So the browser knows where to POST the hotspot login form once a voucher is active.
router.get('/router-host', (req, res) => {
  res.json({ host: config.router.host });
});

router.get('/packages', (req, res) => {
  res.json(db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price ASC').all());
});

// --- Voucher code redemption (cash vouchers printed at the cashier desk) ---

router.post(
  '/vouchers/redeem',
  asyncRoute(async (req, res) => {
    const { code } = req.body;
    const result = await vouchers.activateVoucher({
      code,
      requesterIp: requesterIp(req),
      userId: req.session.user?.id,
    });
    res.json(result);
  })
);

// --- Digital top-up: EcoCash / OneMoney via Paynow (works fully inside the walled garden) ---

router.post(
  '/pay/paynow/initiate',
  asyncRoute(async (req, res) => {
    const { packageId, phone, method } = req.body;
    const pkg = vouchers.getPackage(packageId);
    const reference = `wifi-${Date.now()}`;

    const { pollUrl, instructions } = await paynow.initiateMobilePayment({
      reference,
      amount: pkg.price,
      phone,
      method: method || 'ecocash',
    });

    const result = db
      .prepare(
        `INSERT INTO payment_requests (phone_number, user_id, package_id, provider, provider_reference, poll_url)
         VALUES (?, ?, ?, 'paynow', ?, ?)`
      )
      .run(phone, req.session.user?.id || null, pkg.id, reference, pollUrl);

    res.json({ paymentRequestId: result.lastInsertRowid, instructions });
  })
);

router.get(
  '/pay/paynow/status/:id',
  asyncRoute(async (req, res) => {
    const paymentRequest = db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(req.params.id);
    if (!paymentRequest) return res.status(404).json({ error: 'Payment request not found' });

    if (paymentRequest.status !== 'pending') {
      return res.json({ status: paymentRequest.status, voucherId: paymentRequest.voucher_id });
    }

    const { paid } = await paynow.checkStatus(paymentRequest.poll_url);
    if (!paid) return res.json({ status: 'pending' });

    const voucher = vouchers.issueVoucher({
      packageId: paymentRequest.package_id,
      issueReason: 'self_service',
      issuedToUserId: paymentRequest.user_id,
    });
    const activation = await vouchers.activateVoucher({
      code: voucher.code,
      requesterIp: requesterIp(req),
      userId: paymentRequest.user_id,
    });

    db.prepare("UPDATE payment_requests SET status = 'paid', voucher_id = ?, updated_at = datetime('now') WHERE id = ?").run(
      voucher.id,
      paymentRequest.id
    );
    db.prepare(
      `INSERT INTO sales (transaction_type, payment_method, amount, voucher_id, user_id) VALUES ('voucher', 'ecocash', ?, ?, ?)`
    ).run(voucher.price, voucher.id, paymentRequest.user_id);
    loyalty.awardForSale(paymentRequest.user_id);

    res.json({ status: 'paid', voucher: activation.voucher });
  })
);

// Paynow calls this server-to-server once payment clears. Only reachable if
// this app is exposed publicly (e.g. via the Tailscale/Cloudflare tunnel) —
// the status-polling endpoint above is the reliable path for a LAN-only setup.
router.post('/payments/paynow/webhook', (req, res) => {
  res.sendStatus(200);
});

// --- Digital top-up: Stripe card payment (requires MikroTik walled-garden whitelist) ---

router.post(
  '/pay/stripe/initiate',
  asyncRoute(async (req, res) => {
    const { packageId } = req.body;
    const pkg = vouchers.getPackage(packageId);
    const base = `http://${config.localAppHost}:${config.port}`;

    const { checkoutUrl, sessionId } = await stripe.createCheckoutSession({
      reference: `wifi-${Date.now()}`,
      amountUsd: pkg.price,
      packageName: pkg.name,
      successUrl: `${base}/portal/payment-return?session_id=${'{CHECKOUT_SESSION_ID}'}`,
      cancelUrl: `${base}/`,
    });

    db.prepare(
      `INSERT INTO payment_requests (phone_number, user_id, package_id, provider, provider_reference)
       VALUES ('', ?, ?, 'stripe', ?)`
    ).run(req.session.user?.id || null, pkg.id, sessionId);

    res.json({ checkoutUrl });
  })
);

function receiptRedirectUrl(voucher, pkg, method) {
  const params = new URLSearchParams({
    voucher_activated: '1',
    code: voucher.code,
    mikrotik_username: voucher.mikrotik_username || '',
    package: pkg.name,
    duration: String(voucher.duration_seconds),
    price: String(voucher.price),
    method,
  });
  return `/?${params.toString()}`;
}

router.get(
  '/payment-return',
  asyncRoute(async (req, res) => {
    const sessionId = req.query.session_id;
    const paymentRequest = db.prepare('SELECT * FROM payment_requests WHERE provider_reference = ?').get(sessionId);
    if (!paymentRequest) return res.status(404).send('Payment not found');

    if (paymentRequest.status === 'paid') {
      const existing = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(paymentRequest.voucher_id);
      const pkg = vouchers.getPackage(paymentRequest.package_id);
      return res.redirect(receiptRedirectUrl(existing, pkg, 'stripe'));
    }

    const paid = await stripe.checkSessionPaid(sessionId);
    if (!paid) return res.status(402).send('Payment not completed');

    const voucher = vouchers.issueVoucher({
      packageId: paymentRequest.package_id,
      issueReason: 'self_service',
      issuedToUserId: paymentRequest.user_id,
    });
    const activation = await vouchers.activateVoucher({ code: voucher.code, requesterIp: requesterIp(req), userId: paymentRequest.user_id });

    db.prepare("UPDATE payment_requests SET status = 'paid', voucher_id = ?, updated_at = datetime('now') WHERE id = ?").run(
      voucher.id,
      paymentRequest.id
    );
    db.prepare(
      `INSERT INTO sales (transaction_type, payment_method, amount, voucher_id, user_id) VALUES ('voucher', 'stripe', ?, ?, ?)`
    ).run(voucher.price, voucher.id, paymentRequest.user_id);
    loyalty.awardForSale(paymentRequest.user_id);

    const pkg = vouchers.getPackage(paymentRequest.package_id);
    res.redirect(receiptRedirectUrl(activation.voucher, pkg, 'stripe'));
  })
);

// --- Session control: pause/continue instead of a fixed countdown ---

router.post(
  '/sessions/pause',
  asyncRoute(async (req, res) => {
    const session = await vouchers.pauseSession(req.body.mikrotikUsername);
    res.json({ session });
  })
);

router.post(
  '/sessions/continue',
  asyncRoute(async (req, res) => {
    const session = await vouchers.continueSession(req.body.mikrotikUsername);
    res.json({ session });
  })
);

// --- Account: device binding + history (requires login) ---

router.get('/account', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(req.session.user.id);
  const voucherHistory = db
    .prepare(
      `SELECT v.*, s.status AS session_status FROM vouchers v
       LEFT JOIN sessions_log s ON s.voucher_id = v.id
       WHERE v.issued_to_user_id = ? ORDER BY v.created_at DESC LIMIT 20`
    )
    .all(req.session.user.id);
  res.json({ user: req.session.user, devices, voucherHistory });
});

router.post('/account/devices', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { macAddress, label } = req.body;
  try {
    db.prepare('INSERT INTO devices (user_id, mac_address, label) VALUES (?, ?, ?)').run(
      req.session.user.id,
      macAddress.toLowerCase(),
      label || null
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'That device is already registered' });
  }
});

module.exports = router;
