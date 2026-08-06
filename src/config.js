require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: required('SESSION_SECRET', 'dev-secret-change-me'),
  localAppHost: required('LOCAL_APP_HOST', '10.5.5.5'),

  router: {
    host: required('ROUTER_HOST', '10.5.5.1'),
    port: Number(process.env.ROUTER_API_PORT || 8728),
    user: required('ROUTER_USER', 'admin'),
    password: required('ROUTER_PASSWORD', ''),
  },

  admin: {
    phone: required('ADMIN_PHONE', '0770000000'),
    password: required('ADMIN_PASSWORD', 'change-me'),
  },

  paynow: {
    integrationId: process.env.PAYNOW_INTEGRATION_ID || '',
    integrationKey: process.env.PAYNOW_INTEGRATION_KEY || '',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
  },

  // Default voucher packages — seeded into the DB on first run, editable by admin afterwards.
  defaultPackages: [
    { name: 'Quick Browse', duration_seconds: 4 * 3600, price: 0.25 },
    { name: 'Half Day', duration_seconds: 8 * 3600, price: 0.5 },
    { name: 'Full Day', duration_seconds: 24 * 3600, price: 1.0 },
    { name: 'Weekly', duration_seconds: 7 * 24 * 3600, price: 5.0 },
    { name: 'Fortnight', duration_seconds: 14 * 24 * 3600, price: 8.0 },
  ],
};
