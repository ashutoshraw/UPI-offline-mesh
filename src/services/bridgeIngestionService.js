'use strict';

const idempotencyService = require('./idempotencyService');
const settlementService = require('./settlementService');
const store = require('../models/store');

const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * THE pipeline, ported 1:1 from BridgeIngestionService.java:
 *   1. hash ciphertext (SHA-256)
 *   2. claim the hash in the idempotency cache
 *   3. decrypt with the server's RSA private key (GCM tag verifies integrity)
 *   4. check freshness (signedAt within 24h)
 *   5. settle (debit sender, credit receiver, write ledger)
 */
function ingest(packet, hybridCryptoService) {
  const { HybridCryptoService } = require('../crypto/hybridCrypto');
  const packetHash = HybridCryptoService.hashCiphertext(packet.ciphertext);

  // 1 & 2: dedupe before spending any CPU on RSA.
  const claimed = idempotencyService.claim(packetHash);
  if (!claimed) {
    return { outcome: 'DUPLICATE_DROPPED', packetHash, reason: null, transactionId: null };
  }

  // 3: decrypt + authenticate. Any bit-flip anywhere throws here.
  let payload;
  try {
    payload = hybridCryptoService.decrypt(packet.ciphertext);
  } catch (err) {
    return {
      outcome: 'INVALID',
      packetHash,
      reason: 'DECRYPTION_FAILED',
      transactionId: null
    };
  }

  // 4: reject anything older than 24h (replay protection layer 1).
  const age = Date.now() - payload.signedAt;
  if (age > FRESHNESS_WINDOW_MS || age < 0) {
    return { outcome: 'INVALID', packetHash, reason: 'STALE', transactionId: null };
  }

  // Defense-in-depth: unique index equivalent on packetHash at the storage layer.
  if (!store.claimPacketHash(packetHash)) {
    return { outcome: 'DUPLICATE_DROPPED', packetHash, reason: null, transactionId: null };
  }

  // 5: settle.
  const result = settlementService.settle({
    senderName: payload.sender,
    receiverName: payload.receiver,
    amount: payload.amount,
    packetHash
  });

  return {
    outcome: result.outcome,
    packetHash,
    reason: result.reason || null,
    transactionId: result.transactionId || null
  };
}

module.exports = { ingest };
