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

// Creates an unused voucher row. Doesn't touch MikroTik yet — that happens at
// activation time, once we know which device the customer is redeeming it on.
function issueVoucher({ packageId, issueReason, createdByUserId = null, issuedToUserId = null }) {
  const pkg = getPackage(packageId);
  const code = generateCode();
  const result = db
    .prepare(
      `INSERT INTO vouchers (code, package_id, duration_seconds, price, issue_reason, created_by_user_id, issued_to_user_id)
       VALUES (@code, @package_id, @duration_seconds, @price, @issue_reason, @created_by_user_id, @issued_to_user_id)`
    )
    .run({
      code,
      package_id: pkg.id,
      duration_seconds: pkg.duration_seconds,
      price: pkg.price,
      issue_reason: issueReason,
      created_by_user_id: createdByUserId,
      issued_to_user_id: issuedToUserId,
    });
  return db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid);
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
  activateVoucher,
  pauseSession,
  continueSession,
};
