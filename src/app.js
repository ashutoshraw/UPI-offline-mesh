'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const { HybridCryptoService } = require('./crypto/hybridCrypto');
const { createApiRouter } = require('./routes/api');
const meshSimulatorService = require('./services/meshSimulatorService');

function createApp() {
  // Fresh RSA-2048 keypair each boot, exactly like ServerKeyHolder.java.
  const hybridCryptoService = HybridCryptoService.generateServerKeys();
  meshSimulatorService.init(hybridCryptoService);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/api', createApiRouter(hybridCryptoService));

  // Serve the dashboard. When this app is wrapped for a Netlify Function,
  // static files are instead served by Netlify's CDN directly (see netlify.toml),
  // but this also lets `node server.js` work standalone with zero extra config.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createApp };
