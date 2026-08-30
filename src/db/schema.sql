-- Staff, customers, and the super admin all live in `users`, distinguished by role.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'cashier', 'customer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Devices bonded to a customer account, identified by MAC address.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mac_address TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-editable voucher packages. Seeded with the defaults from config.js on first run.
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  price REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  duration_seconds INTEGER NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'active', 'expired', 'cancelled')),
  issue_reason TEXT NOT NULL DEFAULT 'self_service' CHECK (issue_reason IN ('self_service', 'cash', 'account_topup', 'batch')),
  created_by_user_id INTEGER REFERENCES users(id),
  issued_to_user_id INTEGER REFERENCES users(id),
  used_by_mac TEXT,
  mikrotik_username TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per activated voucher session, tracked independently of MikroTik so the
-- portal can show remaining balance and support pause/continue.
CREATE TABLE IF NOT EXISTS sessions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
  user_id INTEGER REFERENCES users(id),
  device_mac TEXT NOT NULL,
  mikrotik_username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  duration_seconds INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at TEXT,
  ended_at TEXT
);

-- A cashier's till session: opening float, running cash sales, closing count/variance.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  opening_float REAL NOT NULL DEFAULT 0,
  closing_counted REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('voucher', 'gadget')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'ecocash', 'paynow', 'stripe')),
  amount REAL NOT NULL,
  cashier_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  voucher_id INTEGER REFERENCES vouchers(id),
  user_id INTEGER REFERENCES users(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lightweight trail of notable actions for the admin audit log.
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_name TEXT NOT NULL,
  price REAL NOT NULL,
  stock_quantity INTEGER NOT NULL DEFAULT 0
);

-- Tracks in-flight mobile money (Paynow/EcoCash) payments while we poll for confirmation.
CREATE TABLE IF NOT EXISTS payment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  package_id INTEGER NOT NULL REFERENCES packages(id),
  provider TEXT NOT NULL CHECK (provider IN ('paynow', 'stripe')),
  provider_reference TEXT,
  poll_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  voucher_id INTEGER REFERENCES vouchers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
