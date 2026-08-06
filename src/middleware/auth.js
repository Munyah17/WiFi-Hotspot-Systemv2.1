function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: 'Not authorized' });
    next();
  };
}

module.exports = { requireRole };
