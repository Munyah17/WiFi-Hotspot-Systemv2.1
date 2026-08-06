const { RouterOSAPI } = require('node-routeros');
const config = require('../config');

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

module.exports = new MikrotikService();
