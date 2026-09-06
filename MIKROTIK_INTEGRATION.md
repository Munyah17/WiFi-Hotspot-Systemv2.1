# MikroTik Integration Guide

Step-by-step setup for connecting this app to a real MikroTik hAP ac² (or any RouterOS
device) on your hotspot LAN. Do this once the software side has been tested in
`MOCK_MODE` — this guide is for the actual hardware.

Everything here maps directly to what the code expects — `src/config.js` for the `.env`
keys, `src/services/mikrotik.js` for exactly which API calls get made.

## 0. Prerequisites

- RouterOS 6.45+ or any RouterOS 7.x (tested against the RouterOS API's standard binary
  protocol on port 8728 — no REST API required).
- WinBox installed on a PC/laptop that can reach the router (first-time setup is much
  easier in WinBox than via SSH/terminal).
- Physical setup already in place: Starlink → router WAN port, hAP ac² broadcasting the
  open hotspot SSID, the tablet/PC running this app connected to the router's LAN (wired
  or on a trusted, non-hotspot WiFi network/VLAN).

## 1. Run the Hotspot Setup wizard

In WinBox: **IP → Hotspot → Hotspot Setup**, pick the interface serving your open WiFi
SSID, and step through the wizard (LAN address, DHCp pool, DNS, etc.). Accept the
defaults unless you have a specific reason not to — this creates:

- A hotspot server bound to that interface
- A default hotspot user **profile** named `default` — the app's `mikrotik.js` uses this
  profile name unless you pass a different one, so leave it as `default` or update
  `addHotspotUser`'s `profile` parameter to match if you rename it.
- The built-in login pages (`login.html` and friends) — these get replaced in step 4.

## 2. Create a dedicated API user (don't use your WinBox admin login)

**System → Users → Groups**, add a group (e.g. `api-app`) with policies: `read`, `write`,
`api` — and nothing else (no `ftp`, `reboot`, `policy`, `sensitive`, `winbox`, etc.). This
is everything `mikrotik.js` actually calls: printing/adding/setting/removing hotspot
users, reading active sessions, reading the ARP table.

**System → Users**, add a user (e.g. `hotspot-app`) in that group with a strong password.
This becomes `ROUTER_USER` / `ROUTER_PASSWORD` in `.env` — never use the router's main
admin account here.

## 3. Enable the API service

**IP → Services** — confirm `api` is enabled on port `8728` (RouterOS enables this by
default, but check). If you want to restrict which IP can use it, set "Available From" to
the tablet/PC's LAN IP once you've assigned it a static address (see step 6).

## 4. Point the hotspot login page at this app

This is the one step that trips people up, so follow it exactly.

RouterOS's hotspot transparently intercepts any HTTP request from an unauthenticated
client and serves its own `login.html` from the profile's file directory — it doesn't
have a simple "redirect to this external URL" setting. The standard, well-established way
to hand off to a custom portal is to replace that file's contents with a redirect:

1. In WinBox, open **Files**. You'll see `hotspot/login.html` (and `alogin.html`,
   `rlogin.html`, etc. — you only need to edit `login.html` for the default PAP-based flow
   this app uses).
2. Drag `login.html` out to your PC, open it in a text editor, and replace its contents
   entirely with:

   ```html
   <!DOCTYPE html>
   <html><head><meta charset="utf-8">
   <script>window.location.replace("http://10.5.5.5:4000/");</script>
   </head><body>Redirecting…</body></html>
   ```

   Replace `10.5.5.5:4000` with your actual `LOCAL_APP_HOST`/`PORT`. The client is already
   inside the walled garden at this point, so this redirect always succeeds without a
   walled-garden entry for the router's own login page.
3. Drag the edited file back into WinBox's Files list, overwriting the original.

**Also required — enable PAP:** this app logs a device in by POSTing a plain
`username`/`password` form to `http://<router-ip>/login` (see `public/js/portal.js`,
`loginToHotspot`). That only works if the hotspot profile accepts **HTTP PAP** login (the
default RouterOS login.html uses a CHAP challenge that our simplified flow doesn't
generate). Check **IP → Hotspot → Server Profiles → [your profile] → Login** tab and make
sure **HTTP PAP** is ticked. It's on by default in a fresh setup, but confirm it — if it's
off, the login POST will silently fail with "invalid username or password" even though
the voucher code is correct.

## 5. Walled garden entries

**IP → Hotspot → Walled Garden** (the HTTP one, not "Walled Garden IP List" — that's for
non-HTTP traffic):

- Allow `Dst. Host` = `10.5.5.5` (your `LOCAL_APP_HOST`) so unauthenticated clients can
  reach the app itself. If you're strict about it, scope to the port too via the IP List
  version instead.
- If you enable **Stripe** card payments, also allow: `checkout.stripe.com`,
  `js.stripe.com`, `api.stripe.com` (Stripe occasionally uses a few more subdomains for
  fraud checks — watch your Stripe dashboard's logs if a card payment gets stuck partway).
- **EcoCash/OneMoney via Paynow needs no walled-garden entry at all** — the payment
  request is initiated server-side by the app (which has full internet), and the
  customer approves it via USSD over the cellular network, never over WiFi.

## 6. Configure `.env`

```
LOCAL_APP_HOST=<the tablet/PC's static LAN IP>
ROUTER_HOST=<the router's LAN IP, e.g. 10.5.5.1>
ROUTER_API_PORT=8728
ROUTER_USER=hotspot-app
ROUTER_PASSWORD=<the password from step 2>
MOCK_MODE=false
```

Give the app's device a **static LAN IP or DHCP reservation** on the router — if it moves,
every walled-garden entry and the login.html redirect above breaks.

## 7. Verify the connection

1. `npm start` on the app's device.
2. Log into `/admin` and check the "Router" stat tile — it should read **Online**. If not,
   double check `ROUTER_HOST`/`ROUTER_PASSWORD` and that the API service (step 3) is
   reachable from this device (`telnet <router-ip> 8728` should connect).
3. Generate a cash voucher at `/cashier`, connect an actual phone/laptop to the hotspot
   SSID, and redeem the code at the portal. Confirm: the device gets kicked to the login
   redirect, the app's portal loads, redeeming the code logs the device straight onto the
   internet with no manual MikroTik login step, and the device shows up in `/admin`'s live
   network monitor.
4. Test Pause/Continue from the account tab and confirm the device actually loses/regains
   internet access on the router side, not just in the app's UI.

## 8. Turn off mock mode

Once step 7 passes end-to-end, `MOCK_MODE` should already be `false` — just confirm it
didn't get left on from earlier testing. Restart the app after any `.env` change.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Router stat shows Offline | Wrong `ROUTER_HOST`/`ROUTER_PASSWORD`, API service disabled, or a firewall blocking port 8728 between the app's device and the router |
| Login redirect shows the router's *original* MikroTik page, not the app | `login.html` edit didn't save, or you edited the wrong hotspot profile |
| "Invalid username or password" on redeem even with a correct code | HTTP PAP not enabled on the hotspot server profile (step 4) |
| `Could not identify your device on the network` error on redeem | The router's ARP table doesn't have an entry for that IP yet — this is rare but can happen right after a device first joins; having the device make any request first (loading the redirected login page counts) populates it |
| EcoCash prompt never arrives | Not a walled-garden issue — check `PAYNOW_INTEGRATION_ID`/`PAYNOW_INTEGRATION_KEY` are real, and that the field order in `paynow.js` still matches Paynow's current API (flagged in the README as unverified against a live account) |
| Everything works except the customer's *second* device (phone + laptop) both try to use one voucher | Expected — `shared-users=1` deliberately locks one voucher to one MAC address; this is a per-device business model, not a per-person one |
