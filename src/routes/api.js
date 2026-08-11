'use strict';

const express = require('express');
const meshSimulatorService = require('../services/meshSimulatorService');
const bridgeIngestionService = require('../services/bridgeIngestionService');
const store = require('../models/store');

function createApiRouter(hybridCryptoService) {
  const router = express.Router();

  router.get('/server-key', (req, res) => {
    res.json({ publicKey: hybridCryptoService.getPublicKeyBase64() });
  });

  router.get('/accounts', (req, res) => {
    res.json(store.getAccounts());
  });

  router.get('/transactions', (req, res) => {
    res.json(store.getTransactions(20));
  });

  router.get('/mesh/state', (req, res) => {
    res.json(meshSimulatorService.getState());
  });

  router.post('/demo/send', (req, res) => {
    const { sender, receiver, amount, pin } = req.body || {};
    if (!sender || !receiver || !amount || !pin) {
      return res.status(400).json({ error: 'sender, receiver, amount and pin are required' });
    }
    const packet = meshSimulatorService.injectDemo({ sender, receiver, amount: Number(amount), pin });
    res.json({ packet, mesh: meshSimulatorService.getState() });
  });

  router.post('/mesh/gossip', (req, res) => {
    res.json(meshSimulatorService.gossipRound());
  });

  router.post('/mesh/flush', (req, res) => {
    const results = meshSimulatorService.flushBridges();
    res.json({
      results,
      accounts: store.getAccounts(),
      transactions: store.getTransactions(20),
      mesh: meshSimulatorService.getState()
    });
  });

  router.post('/mesh/reset', (req, res) => {
    meshSimulatorService.reset();
    res.json({
      mesh: meshSimulatorService.getState(),
      accounts: store.getAccounts(),
      transactions: store.getTransactions(20)
    });
  });

  // The production endpoint. Real bridges POST here directly.
  router.post('/bridge/ingest', (req, res) => {
    const packet = req.body;
    if (!packet || !packet.ciphertext) {
      return res.status(400).json({ error: 'a MeshPacket body with a ciphertext field is required' });
    }
    const outcome = bridgeIngestionService.ingest(packet, hybridCryptoService);
    res.json(outcome);
  });

  return router;
}

module.exports = { createApiRouter };
