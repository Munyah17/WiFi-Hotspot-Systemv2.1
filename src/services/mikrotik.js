const { RouterOSAPI } = require('node-routeros');
const config = require('../config');

// RouterOS prints durations like "12:00:00", "1d02:03:04", or "3w1d02:03:04" —
// not raw seconds — so extending a user's time budget means parsing whatever
// it hands back, adding to it, and writing the sum back in seconds.
function parseRouterOSDuration(value) {
  if (!value) return 0;
  const str = String(value);
  let seconds = 0;
  const weeks = str.match(/(\d+)w/);
  if (weeks) seconds += Number(weeks[1]) * 7 * 86400;
  const days = str.match(/(\d+)d/);
  if (days) seconds += Number(days[1]) * 86400;
  const hms = str.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (hms) {
    seconds += Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  } else {
    const secOnly = str.match(/^(\d+)s$/);
    if (secOnly) seconds += Number(secOnly[1]);
  }
  return seconds;
}

// Single shared connection to the router, reconnected on demand if it drops
// (cable pulled, router rebooted, etc). Every method below routes through
// `run()`, which retries once after a fresh connect if the first attempt fails.
class MikrotikService {
  constructor() {
    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client && this.client.connected) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new RouterOSAPI({
        host: config.router.host,
        port: config.router.port,
        user: config.router.user,
        password: config.router.password,
      });
      await client.connect();
      this.client = client;
      this.connecting = null;
      return client;
    })();

    return this.connecting;
  }

  async run(command, params = []) {
    try {
      const client = await this.connect();
      return await client.write(command, params);
    } catch (err) {
      // Connection likely dropped — reconnect once and retry before giving up.
      this.client = null;
      const client = await this.connect();
      return client.write(command, params);
    }
  }

  async testConnection() {
    try {
      await this.run('/system/identity/print');
      return true;
    } catch (err) {
      return false;
    }
  }

  // Creates (or re-enables) a hotspot user locked to a specific device MAC,
  // with a time budget in seconds. shared-users=1 stops the code being used
  // on a second device at the same time.
  async addHotspotUser({ username, password, macAddress, limitUptimeSeconds, profile = 'default' }) {
    const params = [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profile}`,
      `=limit-uptime=${limitUptimeSeconds}s`,
      '=shared-users=1',
    ];
    if (macAddress) params.push(`=mac-address=${macAddress}`);
    return this.run('/ip/hotspot/user/add', params);
  }

  async findHotspotUserByName(username) {
    const results = await this.run('/ip/hotspot/user/print', [`?name=${username}`]);
    return results[0] || null;
  }

  async setHotspotUserDisabled(username, disabled) {
    const user = await this.findHotspotUserByName(username);
    if (!user) throw new Error(`Hotspot user not found: ${username}`);
    return this.run('/ip/hotspot/user/set', [`=.id=${user['.id']}`, `=disabled=${disabled ? 'yes' : 'no'}`]);
  }

  // Adds to a user's *existing* time budget in place — this is the "top up 2
  // hours" operation: RouterOS keeps counting cumulative connected time
  // against limit-uptime, so increasing that value is all that's needed;
  // there's no separate "remaining time" field to write.
  async extendHotspotUser(username, additionalSeconds) {
    const user = await this.findHotspotUserByName(username);
    if (!user) throw new Error(`Hotspot user not found: ${username}`);
    const currentSeconds = parseRouterOSDuration(user['limit-uptime']);
    const newSeconds = currentSeconds + additionalSeconds;
    await this.run('/ip/hotspot/user/set', [`=.id=${user['.id']}`, `=limit-uptime=${newSeconds}s`]);
    return newSeconds;
  }

  async removeHotspotUser(username) {
    const user = await this.findHotspotUserByName(username);
    if (!user) return;
    return this.run('/ip/hotspot/user/remove', [`=.id=${user['.id']}`]);
  }

  // Actively connected devices right now — IP, MAC, uptime, bytes in/out.
  async getActiveUsers() {
    return this.run('/ip/hotspot/active/print');
  }

  // Forcibly disconnects a live session (used for both admin "kick" and pause).
  async kickActiveSessionByMac(macAddress) {
    const active = await this.getActiveUsers();
    const session = active.find((s) => (s['mac-address'] || '').toLowerCase() === macAddress.toLowerCase());
    if (!session) return;
    return this.run('/ip/hotspot/active/remove', [`=.id=${session['.id']}`]);
  }

  // Cross-references the requester's LAN IP against the router's ARP table to
  // find their device MAC — this is how we bond a device without needing any
  // client-side script, since the portal page itself doesn't run on the device.
  async getMacForIp(ipAddress) {
    const results = await this.run('/ip/arp/print', [`?address=${ipAddress}`]);
    return results[0]?.['mac-address'] || null;
  }
}

// MOCK_MODE=true swaps in an in-memory fake so the full app can be tested
// end-to-end without a real router on the network. See mikrotikMock.js.
module.exports = config.mockMode ? require('./mikrotikMock') : new MikrotikService();
