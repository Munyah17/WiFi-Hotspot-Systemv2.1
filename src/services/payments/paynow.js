const crypto = require('crypto');
const config = require('../../config');

// Paynow's "mobile" / express-checkout endpoint triggers a USSD prompt on the
// customer's phone over the cellular network — the customer's WiFi device
// never needs internet access for this, which is what makes it work inside
// the hotspot's walled garden. See README for the values you must plug in
// and verify against Paynow's sandbox before taking real payments.
const INITIATE_URL = 'https://www.paynow.co.zw/interface/remotetransaction';
const STATUS_URL_BASE = 'https://www.paynow.co.zw/interface/pollurl';

function computeHash(fields, integrationKey) {
  const concatenated = Object.values(fields).join('') + integrationKey;
  return crypto.createHash('sha512').update(concatenated, 'utf8').digest('hex').toUpperCase();
}

function parseFormEncoded(text) {
  const out = {};
  for (const pair of text.split('&')) {
    const [key, value] = pair.split('=');
    if (key) out[decodeURIComponent(key)] = decodeURIComponent(value || '').replace(/\+/g, ' ');
  }
  return out;
}

// Testing only (MOCK_MODE=true) — simulates a customer approving the USSD
// prompt ~5s after initiating, without calling Paynow at all.
const mockPending = new Map(); // pollUrl -> initiated-at timestamp

// method: 'ecocash' | 'onemoney'
async function initiateMobilePayment({ reference, amount, phone, method, authEmail }) {
  if (config.mockMode) {
    const pollUrl = `mock://paynow/${reference}`;
    mockPending.set(pollUrl, Date.now());
    return { pollUrl, instructions: `[TEST MODE] Simulating ${method} approval for ${phone} — auto-confirms in ~5s.` };
  }

  const { integrationId, integrationKey } = config.paynow;
  if (!integrationId || !integrationKey) {
    throw new Error('Paynow is not configured — set PAYNOW_INTEGRATION_ID and PAYNOW_INTEGRATION_KEY in .env');
  }

  // NOTE: Paynow validates the request hash using this exact field order.
  // Verify this against a live sandbox transaction before going live —
  // if Paynow changes/adds fields the hash must be recomputed in the same order.
  const fields = {
    id: integrationId,
    reference,
    amount: amount.toFixed(2),
    additionalinfo: 'WiFi voucher top-up',
    returnurl: `http://${config.localAppHost}:${config.port}/portal/payment-return`,
    resulturl: `http://${config.localAppHost}:${config.port}/portal/payments/paynow/webhook`,
    authemail: authEmail || 'noreply@example.com',
    phone,
    method,
    status: 'Message',
  };
  const hash = computeHash(fields, integrationKey);

  const body = new URLSearchParams({ ...fields, hash }).toString();
  const res = await fetch(INITIATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const parsed = parseFormEncoded(await res.text());

  if (parsed.status?.toLowerCase() !== 'ok') {
    throw new Error(parsed.error || 'Paynow rejected the payment request');
  }

  return {
    pollUrl: parsed.pollurl,
    instructions: parsed.instructions || 'Approve the payment prompt on your phone.',
  };
}

async function checkStatus(pollUrl) {
  if (pollUrl.startsWith('mock://')) {
    const paid = Date.now() - (mockPending.get(pollUrl) || 0) > 5000;
    return { paid, status: paid ? 'Paid' : 'Sent', raw: {} };
  }

  const res = await fetch(pollUrl, { method: 'POST' });
  const parsed = parseFormEncoded(await res.text());
  return {
    paid: parsed.status?.toLowerCase() === 'paid',
    status: parsed.status,
    raw: parsed,
  };
}

module.exports = { initiateMobilePayment, checkStatus };
