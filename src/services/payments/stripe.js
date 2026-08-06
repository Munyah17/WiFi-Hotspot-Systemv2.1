const config = require('../../config');

// Card payments need the customer's browser to reach Stripe's hosted checkout
// directly (PCI compliance — we never touch card numbers), which means
// checkout.stripe.com and friends must be added to MikroTik's hotspot
// walled garden. See README. We verify payment by polling the session on
// return rather than requiring an inbound webhook, since this app runs on a
// LAN device that typically isn't publicly reachable.
const API_BASE = 'https://api.stripe.com/v1';

function authHeader() {
  if (!config.stripe.secretKey) {
    throw new Error('Stripe is not configured — set STRIPE_SECRET_KEY in .env');
  }
  return { Authorization: `Bearer ${config.stripe.secretKey}` };
}

// Testing only (MOCK_MODE=true) — skips Stripe entirely and jumps straight to
// the success URL with a fake session id that checkSessionPaid recognizes.
async function createCheckoutSession({ reference, amountUsd, packageName, successUrl, cancelUrl }) {
  if (config.mockMode) {
    const sessionId = `mock_${reference}`;
    return { checkoutUrl: successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId), sessionId };
  }

  const body = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(amountUsd * 100)),
    'line_items[0][price_data][product_data][name]': packageName,
    client_reference_id: reference,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  const res = await fetch(`${API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const session = await res.json();
  if (!res.ok) throw new Error(session.error?.message || 'Stripe checkout session creation failed');
  return { checkoutUrl: session.url, sessionId: session.id };
}

async function checkSessionPaid(sessionId) {
  if (sessionId.startsWith('mock_')) return true;

  const res = await fetch(`${API_BASE}/checkout/sessions/${sessionId}`, { headers: authHeader() });
  const session = await res.json();
  if (!res.ok) throw new Error(session.error?.message || 'Could not retrieve Stripe session');
  return session.payment_status === 'paid';
}

module.exports = { createCheckoutSession, checkSessionPaid };
