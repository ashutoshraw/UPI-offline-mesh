'use strict';

const { createApp } = require('./src/app');

const PORT = process.env.PORT || 8080;
const app = createApp();

app.listen(PORT, () => {
  console.log(`UPI Offline Mesh (JS) listening on http://localhost:${PORT}`);
  console.log('Open that URL in your browser for the dashboard.');
});
