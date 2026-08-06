const db = require('./db');

function logAction(actorUserId, action, targetType, targetId, details) {
  db.prepare(
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(actorUserId || null, action, targetType || null, targetId != null ? String(targetId) : null, details ? JSON.stringify(details) : null);
}

module.exports = { logAction };
