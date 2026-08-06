// Local/LAN entry point — `npm start` on the tablet or PC. Not used on Vercel;
// see api/index.js, which imports app.js directly without calling listen().
const app = require('./app');
const config = require('./config');

app.listen(config.port, () => {
  console.log(`Hotspot cafe app listening on http://${config.localAppHost}:${config.port}`);
});
