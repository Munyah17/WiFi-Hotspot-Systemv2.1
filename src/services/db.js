const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('../config');

// Uses Node's built-in SQLite module (Node 22.5+) rather than a native addon
// like better-sqlite3 — no compiler/Python toolchain needed, which matters a
// lot when this has to install cleanly inside Termux on a tablet.
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'hotspot.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
db.exec(schema);

function seedDefaults() {
  const packageCount = db.prepare('SELECT COUNT(*) AS n FROM packages').get().n;
  if (packageCount === 0) {
    const insert = db.prepare(
      'INSERT INTO packages (name, duration_seconds, price) VALUES (@name, @duration_seconds, @price)'
    );
    for (const pkg of config.defaultPackages) insert.run(pkg);
  }

  const adminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (adminCount === 0) {
    const hash = bcrypt.hashSync(config.admin.password, 10);
    db.prepare(
      'INSERT INTO users (phone_number, password_hash, full_name, role) VALUES (?, ?, ?, ?)'
    ).run(config.admin.phone, hash, 'Super Admin', 'admin');
  }
}

seedDefaults();

module.exports = db;
