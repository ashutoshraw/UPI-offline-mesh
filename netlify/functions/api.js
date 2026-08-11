'use strict';

const serverless = require('serverless-http');
const express = require('express');
const cors = require('cors');
const { HybridCryptoService } = require('../../src/crypto/hybridCrypto');
const { createApiRouter } = require('../../src/routes/api');
const meshSimulatorService = require('../../src/services/meshSimulatorService');

/**
 * IMPORTANT — read this before you demo the hosted version:
 *
 * Netlify Functions are stateless AWS Lambda-style containers. This module-level
 * state (the RSA keypair, the in-memory accounts/devices) survives *only* while
 * the container stays warm between invocations - which is usually true for a
 * few back-to-back clicks in one browser session, but is NOT guaranteed. A cold
 * start (first request in a while, or Netlify spinning up a second concurrent
 * container) gets a brand-new keypair and reset accounts, silently.
 *
 * For a resume demo you click through live, this is normally fine. For a
 * always-consistent hosted demo, swap the accounts/transactions/mesh state and
 * idempotency cache for a real external store (see README "Netlify caveats").
 */
let appPromise = null;

function getApp() {
  if (!appPromise) {
    const hybridCryptoService = HybridCryptoService.generateServerKeys();
    meshSimulatorService.init(hybridCryptoService);

    const app = express();
    app.use(cors());
    app.use(express.json());
    app.use('/api', createApiRouter(hybridCryptoService));

    appPromise = app;
  }
  return appPromise;
}

const handlerFor = serverless(getApp());

module.exports.handler = async (event, context) => handlerFor(event, context);
