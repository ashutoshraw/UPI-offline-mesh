'use strict';

const store = require('../models/store');

/**
 * Mirrors SettlementService.java's @Transactional debit + credit + ledger insert.
 * There's no real DB transaction here (it's one in-memory store mutated
 * synchronously), which is the honest JS equivalent of "no isolation needed
 * because nothing else can interleave mid-function in a single event-loop tick".
 */
function settle({ senderName, receiverName, amount, packetHash }) {
  const sender = store.findAccountByName(senderName);
  const receiver = store.findAccountByName(receiverName);

  if (!sender || !receiver) {
    return { outcome: 'INVALID', reason: 'UNKNOWN_ACCOUNT' };
  }

  if (sender.balance < amount) {
    // Honest limitation from the original README: the receiver's phone showing
    // "sent" is an IOU, not a settled payment, until the backend confirms funds.
    store.insertTransaction({
      senderId: sender.id,
      receiverId: receiver.id,
      amount,
      packetHash,
      status: 'REJECTED'
    });
    return { outcome: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' };
  }

  sender.balance -= amount;
  sender.version += 1;
  receiver.balance += amount;
  receiver.version += 1;

  const tx = store.insertTransaction({
    senderId: sender.id,
    receiverId: receiver.id,
    amount,
    packetHash,
    status: 'SETTLED'
  });

  return { outcome: 'SETTLED', transactionId: tx.id };
}

module.exports = { settle };
