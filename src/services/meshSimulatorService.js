'use strict';

const crypto = require('crypto');
const bridgeIngestionService = require('./bridgeIngestionService');
const idempotencyService = require('./idempotencyService');
const store = require('../models/store');

const DEFAULT_TTL = 5;

function seedDevices() {
  return [
    { id: 'phone-alice', hasInternet: false, packets: [] },
    { id: 'stranger-1', hasInternet: false, packets: [] },
    { id: 'stranger-2', hasInternet: false, packets: [] },
    { id: 'phone-bridge', hasInternet: true, packets: [] }
  ];
}

let devices = seedDevices();
let hybridCryptoService = null; // injected from server.js at boot

function init(cryptoService) {
  hybridCryptoService = cryptoService;
}

function reset() {
  devices = seedDevices();
  store.reset();
  idempotencyService.reset();
}

function getState() {
  return devices.map((d) => ({
    id: d.id,
    hasInternet: d.hasInternet,
    packetCount: d.packets.length,
    packets: d.packets.map((p) => ({ packetId: p.packetId, ttl: p.ttl }))
  }));
}

/**
 * Simulates the sender's own phone: builds a PaymentInstruction, encrypts it
 * with the server's public key, wraps it in a MeshPacket, and hands it to
 * phone-alice - exactly what DemoService.createPacket() did.
 */
function injectDemo({ sender, receiver, amount, pin }) {
  const payload = {
    sender,
    receiver,
    amount,
    pinHash: crypto.createHash('sha256').update(String(pin)).digest('hex'),
    nonce: crypto.randomUUID(),
    signedAt: Date.now()
  };

  const ciphertext = hybridCryptoService.encrypt(payload);

  const packet = {
    packetId: crypto.randomUUID(),
    ttl: DEFAULT_TTL,
    createdAt: Date.now(),
    ciphertext
  };

  const alice = devices.find((d) => d.id === 'phone-alice');
  alice.packets.push(packet);

  return packet;
}

/**
 * One gossip round: every device broadcasts every packet it holds to every
 * other device "in range" (everyone, in this simulator). TTL decrements per
 * hop; packets that hit TTL 0 are dropped.
 */
function gossipRound() {
  const broadcastPacketsById = new Map();
  for (const device of devices) {
    for (const packet of device.packets) {
      if (!broadcastPacketsById.has(packet.packetId)) {
        broadcastPacketsById.set(packet.packetId, packet);
      }
    }
  }

  for (const packet of broadcastPacketsById.values()) {
    const hoppedPacket = { ...packet, ttl: packet.ttl - 1 };
    if (hoppedPacket.ttl <= 0) continue;

    for (const device of devices) {
      const alreadyHas = device.packets.some((p) => p.packetId === hoppedPacket.packetId);
      if (!alreadyHas) {
        device.packets.push(hoppedPacket);
      } else {
        // keep the freshest TTL value for a packet a device already holds
        device.packets = device.packets.map((p) =>
          p.packetId === hoppedPacket.packetId && p.ttl < hoppedPacket.ttl
            ? hoppedPacket
            : p
        );
      }
    }
  }

  // drop anything that decayed to 0 in this round
  for (const device of devices) {
    device.packets = device.packets.filter((p) => p.ttl > 0);
  }

  return getState();
}

/**
 * Devices with hasInternet=true "walk outside" and POST every packet they
 * hold to the ingestion pipeline, then clear their outbox.
 */
function flushBridges() {
  const results = [];
  for (const device of devices) {
    if (!device.hasInternet) continue;
    for (const packet of device.packets) {
      const outcome = bridgeIngestionService.ingest(packet, hybridCryptoService);
      results.push({ bridgeId: device.id, packetId: packet.packetId, ...outcome });
    }
    device.packets = [];
  }
  return results;
}

module.exports = { init, reset, getState, injectDemo, gossipRound, flushBridges };
