// Vercel serverless entry point. Vercel's Node builder treats an exported
// Express app as a request handler directly — no app.listen() here.
// See vercel.json for the rewrite that sends every path through this function,
// and README's "Testing on Vercel" section for why this only ever runs in
// MOCK_MODE (no real router or payment gateway reachable from Vercel).
module.exports = require('../src/app');
