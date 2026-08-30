const crypto = require('crypto');
const db = require('./db');
const mikrotik = require('./mikrotik');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity on printed receipts

function generateCode(segments = 3, segmentLength = 4) {
  const randomSegment = () =>
    Array.from(crypto.randomBytes(segmentLength))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join('');
  return Array.from({ length: segments }, randomSegment).join('-');
}

function getPackage(packageId) {
  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(packageId);
  if (!pkg) throw new Error(`Unknown or inactive package: ${packageId}`);
  return pkg;
}

const insertVoucherStmt = db.prepare(
  `INSERT INTO vouchers (code, package_id, duration_seconds, price, issue_reason, created_by_user_id, issued_to_user_id)
   VALUES (@code, @package_id, @duration_seconds, @price, @issue_reason, @created_by_user_id, @issued_to_user_id)`
);

// Creates an unused voucher row. Doesn't touch MikroTik yet — that happens at
// activation time, once we know which device the customer is redeeming it on.
// Retries on a code collision — astronomically unlikely for one voucher, but
// worth guarding once batches of hundreds are generated at a time.
function issueVoucher({ packageId, issueReason, createdByUserId = null, issuedToUserId = null, pkg = null }) {
  const resolvedPkg = pkg || getPackage(packageId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = insertVoucherStmt.run({
        code: generateCode(),
        package_id: resolvedPkg.id,
        duration_seconds: resolvedPkg.duration_seconds,
        price: resolvedPkg.price,
        issue_reason: issueReason,
        created_by_user_id: createdByUserId,
        issued_to_user_id: issuedToUserId,
      });
      return db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid);
    } catch (err) {
      if (attempt === 4 || !/UNIQUE constraint failed/.test(err.message)) throw err;
    }
  }
}

const MAX_BATCH_SIZE = 500;

// 1-click bulk generation: one package, N unused vouchers, ready to print as
// physical cards. Doesn't touch MikroTik and doesn't record a sale — these
// are pre-printed stock, not a point of sale; each one is only "sold" (and
// should be recorded as such) when it's actually handed over for payment.
function issueVouchersBatch({ packageId, quantity, createdByUserId = null }) {
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_BATCH_SIZE) {
    throw new Error(`Quantity must be a whole number between 1 and ${MAX_BATCH_SIZE}`);
  }
  const pkg = getPackage(packageId);
  const batch = [];
  for (let i = 0; i < qty; i++) {
    batch.push(issueVoucher({ pkg, issueReason: 'batch', createdByUserId }));
  }
  return batch;
}

// Redeems a voucher for the device at `requesterIp`, binding it to that
// device's MAC on the router and starting the session clock.
async function activateVoucher({ code, requesterIp, userId = null }) {
  const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
  if (!voucher) throw new Error('Voucher code not found');
  if (voucher.status !== 'unused') throw new Error('Voucher has already been used or expired');

  const macAddress = await mikrotik.getMacForIp(requesterIp);
  if (!macAddress) throw new Error('Could not identify your device on the network — try reconnecting to WiFi');

  const mikrotikUsername = `v-${voucher.code}`.toLowerCase();
  await mikrotik.addHotspotUser({
    username: mikrotikUsername,
    password: mikrotikUsername,
    macAddress,
    limitUptimeSeconds: voucher.duration_seconds,
  });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE vouchers SET status = 'active', used_by_mac = ?, mikrotik_username = ?, activated_at = ?, issued_to_user_id = COALESCE(issued_to_user_id, ?)
     WHERE id = ?`
  ).run(macAddress, mikrotikUsername, now, userId, voucher.id);

  db.prepare(
    `INSERT INTO sessions_log (voucher_id, user_id, device_mac, mikrotik_username, duration_seconds)
     VALUES (?, ?, ?, ?, ?)`
  ).run(voucher.id, userId, macAddress, mikrotikUsername, voucher.duration_seconds);

  return { voucher: db.prepare('SELECT * FROM vouchers WHERE id = ?').get(voucher.id), macAddress, mikrotikUsername };
}

// Disables the hotspot login and disconnects the active session, but the
// router keeps the accumulated uptime — so remaining balance survives.
async function pauseSession(mikrotikUsername) {
  const session = db
    .prepare("SELECT * FROM sessions_log WHERE mikrotik_username = ? AND status = 'active'")
    .get(mikrotikUsername);
  if (!session) throw new Error('No active session for this voucher');

  await mikrotik.setHotspotUserDisabled(mikrotikUsername, true);
  await mikrotik.kickActiveSessionByMac(session.device_mac);

  db.prepare("UPDATE sessions_log SET status = 'paused', paused_at = datetime('now') WHERE id = ?").run(session.id);
  return session;
}

function findActiveSessionForUser(userId) {
  return db
    .prepare("SELECT * FROM sessions_log WHERE user_id = ? AND status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1")
    .get(userId);
}

// If the customer already has a session running (or paused), this adds the
// package's time directly onto that same MikroTik user's budget — a real
// top-up, not a second parallel voucher. Only falls back to crediting a
// fresh unused voucher (today's redeem-later flow) if they have nothing active.
async function topUpUser({ userId, packageId, issueReason = 'account_topup', createdByUserId = null }) {
  const pkg = getPackage(packageId);
  const session = findActiveSessionForUser(userId);

  const voucher = issueVoucher({ packageId, issueReason, createdByUserId, issuedToUserId: userId });

  if (!session) {
    return { voucher, mode: 'credited' };
  }

  await mikrotik.extendHotspotUser(session.mikrotik_username, pkg.duration_seconds);
  db.prepare('UPDATE sessions_log SET duration_seconds = duration_seconds + ? WHERE id = ?').run(pkg.duration_seconds, session.id);
  db.prepare(
    `UPDATE vouchers SET status = 'active', used_by_mac = ?, mikrotik_username = ?, activated_at = datetime('now') WHERE id = ?`
  ).run(session.device_mac, session.mikrotik_username, voucher.id);

  return {
    voucher: db.prepare('SELECT * FROM vouchers WHERE id = ?').get(voucher.id),
    mode: 'extended',
    mikrotikUsername: session.mikrotik_username,
  };
}

async function continueSession(mikrotikUsername) {
  const session = db
    .prepare("SELECT * FROM sessions_log WHERE mikrotik_username = ? AND status = 'paused'")
    .get(mikrotikUsername);
  if (!session) throw new Error('No paused session for this voucher');

  await mikrotik.setHotspotUserDisabled(mikrotikUsername, false);

  db.prepare("UPDATE sessions_log SET status = 'active', paused_at = NULL WHERE id = ?").run(session.id);
  return session;
}

module.exports = {
  generateCode,
  getPackage,
  issueVoucher,
  issueVouchersBatch,
  activateVoucher,
  topUpUser,
  pauseSession,
  continueSession,
};
