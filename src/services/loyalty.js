const db = require('./db');

// One point per completed sale — simple and easy to reason about at the till.
function awardForSale(userId, points = 1) {
  if (!userId) return;
  db.prepare('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?').run(points, userId);
}

function adjust(userId, delta) {
  db.prepare('UPDATE users SET loyalty_points = MAX(0, loyalty_points + ?) WHERE id = ?').run(delta, userId);
}

module.exports = { awardForSale, adjust };
