const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');

const authRoutes = require('./routes/auth');
const portalRoutes = require('./routes/portal');
const cashierRoutes = require('./routes/cashier');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12h — long enough for a cashier/admin shift
  })
);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('/cashier', (req, res) => res.sendFile(path.join(publicDir, 'cashier.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

app.use('/api/auth', authRoutes);
app.use('/portal', portalRoutes); // serves both the JSON API and the payment-return browser redirect
app.use('/api/cashier', cashierRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true, mockMode: config.mockMode }));

module.exports = app;
