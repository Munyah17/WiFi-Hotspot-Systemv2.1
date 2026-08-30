// In-memory stand-in for the RouterOS API, used when MOCK_MIKROTIK=true so the
// full app flow (redeem/pay -> device bound -> active in admin -> pause/kick)
// can be exercised end-to-end without a real MikroTik router on the network.
// Mirrors the method signatures of services/mikrotik.js exactly.

const hotspotUsers = new Map(); // username -> { macAddress, disabled, limitUptimeSeconds }
const activeSessions = new Map(); // macAddress -> active-session-like row
const ipToMac = new Map(); // simulates the router's ARP table

function fakeMacForIp(ipAddress) {
  if (!ipToMac.has(ipAddress)) {
    const n = ipToMac.size + 1;
    ipToMac.set(ipAddress, `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`);
  }
  return ipToMac.get(ipAddress);
}

module.exports = {
  async testConnection() {
    return true;
  },

  async addHotspotUser({ username, macAddress, limitUptimeSeconds }) {
    hotspotUsers.set(username, { macAddress, disabled: false, limitUptimeSeconds });
    activeSessions.set(macAddress, {
      '.id': `*${username}`,
      user: username,
      address: `10.5.5.${50 + hotspotUsers.size}`,
      'mac-address': macAddress,
      uptime: '0s',
    });
    console.log(`[mock-mikrotik] hotspot user added: ${username} -> ${macAddress} (${limitUptimeSeconds}s)`);
    return [{ ret: username }];
  },

  async findHotspotUserByName(username) {
    const u = hotspotUsers.get(username);
    return u ? { '.id': `*${username}`, name: username, disabled: u.disabled ? 'true' : 'false' } : null;
  },

  async setHotspotUserDisabled(username, disabled) {
    const u = hotspotUsers.get(username);
    if (!u) throw new Error(`Hotspot user not found: ${username}`);
    u.disabled = disabled;
    if (disabled) activeSessions.delete(u.macAddress);
    console.log(`[mock-mikrotik] hotspot user ${username} disabled=${disabled}`);
  },

  async extendHotspotUser(username, additionalSeconds) {
    const u = hotspotUsers.get(username);
    if (!u) throw new Error(`Hotspot user not found: ${username}`);
    u.limitUptimeSeconds += additionalSeconds;
    console.log(`[mock-mikrotik] extended ${username} by ${additionalSeconds}s -> ${u.limitUptimeSeconds}s total`);
    return u.limitUptimeSeconds;
  },

  async removeHotspotUser(username) {
    const u = hotspotUsers.get(username);
    if (u) activeSessions.delete(u.macAddress);
    hotspotUsers.delete(username);
  },

  async getActiveUsers() {
    return Array.from(activeSessions.values());
  },

  async kickActiveSessionByMac(macAddress) {
    activeSessions.delete(macAddress);
    console.log(`[mock-mikrotik] kicked ${macAddress}`);
  },

  async getMacForIp(ipAddress) {
    return fakeMacForIp(ipAddress);
  },
};
