# WiFi Cafe — Hotspot Business Management System

In-house app for a single Starlink + MikroTik WiFi hotspot cafe. MikroTik enforces the
captive portal and internet access; this app is the business layer on top of it —
vouchers, accounts, payments, staff, and live network visibility.

Runs entirely on one device on the same LAN as the router (tablet via Termux, or a PC).
No cloud dependency required for the core system to work.

## Why it has to run locally

Customers on the open WiFi have **no internet access at all** until they pay — MikroTik's
hotspot puts them in a "walled garden" that can only reach whitelisted destinations. That
means the voucher/payment portal itself must be served from a device on the LAN, not a
cloud host. See the walled-garden section below for how digital payment still works from
inside that restricted state.

## Testing without hardware

Set `MOCK_MODE=true` in `.env` to swap the real MikroTik connection and Paynow/Stripe calls
for in-memory fakes (`src/services/mikrotikMock.js`, and short-circuits inside
`paynow.js`/`stripe.js`) — lets you exercise the full flow (buy/redeem → device bound →
shows up in admin → pause/continue/kick) without a router or payment credentials. Digital
payments auto-"approve" ~5s after initiating. **Set it back to `false` before real use.**

### Testing on Vercel

This is normally a long-running local server (`app.listen()`), which isn't how Vercel's
serverless functions work — `api/index.js` exports the same Express app for Vercel's Node
builder to wrap, and `vercel.json` routes every path through it. This is **for UI/flow
testing only** — remove the Vercel project once you're done:

- It always runs in `MOCK_MODE`, forced on automatically (`config.js` checks
  `process.env.VERCEL`) regardless of any env var you set — there's no MikroTik reachable
  from Vercel, and it must never pick up real payment keys.
- The SQLite file lives in `/tmp` on Vercel (the project directory is read-only), which is
  wiped on cold starts — mock data will periodically reset. That's expected.
- Sessions use an in-memory store, which doesn't survive across Vercel's serverless
  instances — login can appear to randomly log you out between requests. Not worth fixing
  for a throwaway preview.
- None of this makes Vercel a real deployment target for the actual system — see "Why it
  has to run locally" above. This exists purely so the UI/flow can be clicked through and
  shared as a link during testing.

## Setup

```
npm install
cp .env.example .env   # then fill in ROUTER_PASSWORD, ADMIN_PASSWORD, payment keys, etc.
npm start
```

On first run this creates `data/hotspot.db` (SQLite), seeds the default voucher packages,
and creates the super admin account from `ADMIN_PHONE` / `ADMIN_PASSWORD` in `.env`.

- Customer portal: `http://<LOCAL_APP_HOST>:<PORT>/`
- Cashier: `http://<LOCAL_APP_HOST>:<PORT>/cashier`
- Admin: `http://<LOCAL_APP_HOST>:<PORT>/admin`

### Running on an Android tablet (Termux)

```
pkg install nodejs-lts
# better-sqlite3 needs build tools to compile its native binding:
pkg install python make clang
npm install
npm start
```

Keep Termux running in the background: `termux-wake-lock`, and consider `termux-boot` so
the app restarts automatically if the tablet reboots.

## MikroTik configuration (RouterOS / WinBox)

1. Set up the hotspot as normal (`IP > Hotspot > Hotspot Setup`) on the interface serving
   your open WiFi network.
2. Point the hotspot's login page at this app instead of the built-in one, or simply direct
   customers to `http://<LOCAL_APP_HOST>:<PORT>/` — MikroTik redirects unauthenticated
   HTTP traffic there automatically once it's in the walled garden.
3. Add walled-garden entries (`IP > Hotspot > Walled Garden`) so unauthenticated devices can
   reach:
   - This app's IP/port (`<LOCAL_APP_HOST>:<PORT>`)
   - Stripe's checkout domains, if you enable card payments: `checkout.stripe.com`,
     `js.stripe.com`, `api.stripe.com` (Stripe may use a few more subdomains for fraud
     checks — check your Stripe dashboard's checkout logs if a card payment gets stuck)
   - EcoCash/Paynow do **not** need a walled-garden entry — see below.
4. In the API settings (`IP > Services`), make sure the API service (port 8728) is enabled
   and reachable from this app's device, and create/use the router user in `.env`.

## How digital payment works inside the walled garden

- **EcoCash / OneMoney (via Paynow)**: this app calls Paynow's API directly using its own
  internet connection (the app's device has full internet; only guest WiFi clients are
  walled off). Paynow then sends a USSD/mobile-money approval prompt to the customer's
  phone over the **cellular network**, completely separate from WiFi. No walled-garden
  entry needed. This is the default, "just works" payment path.
- **Stripe (card)**: requires the customer's own browser to reach Stripe's hosted checkout,
  so it needs the walled-garden whitelist above. Slightly more setup, offer as a secondary
  option.
- **Cash**: handled entirely at the cashier desk, no gateway involved.

⚠️ The Paynow hash/field-order implementation in `src/services/payments/paynow.js` is
built from their published API shape but has **not been tested against a live Paynow
account** — verify it against Paynow's sandbox before taking real payments, and adjust the
field order in `initiateMobilePayment` if their API rejects the hash.

## Pause / Continue

MikroTik's hotspot `limit-uptime` already tracks *accumulated connected time*, not
wall-clock time — disconnecting doesn't burn the customer's remaining balance. Pause
disables the hotspot login and kicks the active session; Continue re-enables it. No
manual voucher re-entry needed.

## Device binding

When a voucher is redeemed or a payment clears, the app looks up the requester's MAC
address via the router's ARP table (matching their LAN IP) and creates a MikroTik hotspot
user locked to that MAC with `shared-users=1` — so one voucher code = one device.

## Remote admin access

There's no built-in cloud sync. For remote access to `/admin` while off-site, run
[Tailscale](https://tailscale.com) (or Cloudflare Tunnel) on the device hosting this app —
it gives you a private, authenticated link to the same local dashboard from your phone,
without exposing the hotspot LAN or building a second copy of the data.

## Project structure

```
src/
  config.js              env/config, default packages
  db/schema.sql           SQLite schema
  services/
    db.js                 SQLite connection + seeding
    mikrotik.js            RouterOS API client (add/remove hotspot users, active sessions, ARP lookup)
    vouchers.js            voucher issuing/activation, pause/continue
    payments/paynow.js     EcoCash/OneMoney via Paynow
    payments/stripe.js     card payments via Stripe Checkout
  middleware/auth.js       role-based route guards
  routes/                  portal (customer), cashier, admin, auth
public/                    portal, cashier, and admin front-ends (Tailwind CDN + vanilla JS)
```

## Business management layer

Beyond the voucher/payment core: cashier shift open/close with cash reconciliation
(`/cashier`), customer lookup with account suspend/activate, "extend access" (credit a
voucher to an account), loyalty points (1 per completed sale, manually adjustable), an
admin audit log of staff/admin actions, a sales/reports view with date-range filtering, and
a basic shop/inventory module with walk-in accessory sales. Staff edit is name/role only —
no hard delete, since past vouchers/sales stay attributed to the staff member who created
them; suspend a staff account instead.

## Not built yet (deliberately out of scope for now)

- Pre-arrival remote top-up auto-activation for bonded devices (buy from home, connect
  later and get in immediately) — the current flow activates against whichever device is
  making the request at payment time.
- Network health/smart-business layer: bandwidth/speed/latency monitoring, per-user data
  consumption, FUP/bandwidth rate-limiting, abuse/tethering detection, router uptime
  history, signal/blind-spot mapping across range extenders.
- AI insights, weather-sensor integration.
- ESC-POS Bluetooth thermal printer output (the cashier receipt view is print-friendly via
  the browser's print dialog for now).
