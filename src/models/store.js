'use strict';

/**
 * In-memory stand-in for the H2 database + Spring Data JPA repositories.
 * Account.java's @Version optimistic lock becomes a plain integer bumped on every write;
 * Transaction.java's unique index on packetHash becomes a Set check.
 */

let accounts;
let transactions;
let nextTransactionId;
let seenPacketHashes; // defense-in-depth uniqueness, mirrors the DB unique index

function seedAccounts() {
  return [
    { id: 1, name: 'alice', vpa: 'alice@mesh', balance: 2000, version: 0 },
    { id: 2, name: 'bob', vpa: 'bob@mesh', balance: 500, version: 0 },
    { id: 3, name: 'carol', vpa: 'carol@mesh', balance: 500, version: 0 }
  ];
}

function reset() {
  accounts = seedAccounts();
  transactions = [];
  nextTransactionId = 1;
  seenPacketHashes = new Set();
}

reset();

function getAccounts() {
  return accounts;
}

function findAccountByName(name) {
  return accounts.find((a) => a.name === name);
}

function getTransactions(limit = 20) {
  return transactions.slice(-limit).reverse();
}

/** Reserves a packetHash. Returns false if it was already used (defense-in-depth duplicate). */
function claimPacketHash(packetHash) {
  if (seenPacketHashes.has(packetHash)) return false;
  seenPacketHashes.add(packetHash);
  return true;
}

function insertTransaction({ senderId, receiverId, amount, packetHash, status }) {
  const tx = {
    id: nextTransactionId++,
    senderId,
    receiverId,
    amount,
    packetHash,
    status,
    settledAt: Date.now()
  };
  transactions.push(tx);
  return tx;
}

module.exports = {
  reset,
  getAccounts,
  findAccountByName,
  getTransactions,
  claimPacketHash,
  insertTransaction
};
