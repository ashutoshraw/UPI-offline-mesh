'use strict';

const API = '/api';

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function setFeedback(id, message, kind) {
  const node = el(id);
  node.textContent = message;
  node.className = `feedback ${kind || ''}`;
}

function signalIconSvg() {
  return `<svg class="signal-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M2 12a15 15 0 0 1 20 0"/><path d="M6 15.5a9 9 0 0 1 12 0"/><path d="M10 19a4 4 0 0 1 4 0"/>
  </svg>`;
}

async function refreshAccounts() {
  const accounts = await api('/accounts');
  const tbody = document.querySelector('#accountsTable tbody');
  tbody.innerHTML = accounts
    .map((a) => `<tr><td>${a.name}</td><td>${a.vpa}</td><td>₹${a.balance.toFixed(2)}</td></tr>`)
    .join('');

  const senderSelect = el('senderSelect');
  const receiverSelect = el('receiverSelect');
  const options = accounts.map((a) => `<option value="${a.name}">${a.name}</option>`).join('');
  senderSelect.innerHTML = options;
  receiverSelect.innerHTML = options;
  senderSelect.value = accounts[0]?.name;
  receiverSelect.value = accounts[1]?.name;
}

async function refreshTransactions() {
  const txs = await api('/transactions');
  const accounts = await api('/accounts');
  const nameById = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const tbody = document.querySelector('#txTable tbody');
  tbody.innerHTML = txs
    .map(
      (t) => `<tr>
        <td>#${t.id}</td>
        <td>${nameById[t.senderId] || t.senderId} → ${nameById[t.receiverId] || t.receiverId}</td>
        <td>₹${t.amount}</td>
        <td><span class="status-pill ${t.status}">${t.status}</span></td>
        <td>${t.packetHash.slice(0, 12)}…</td>
      </tr>`
    )
    .join('');
}

async function refreshMesh() {
  const state = await api('/mesh/state');
  const grid = el('deviceGrid');
  grid.innerHTML = state
    .map(
      (d) => `<div class="device-card ${d.hasInternet ? 'bridge' : ''}">
        <div class="name">${signalIconSvg()} ${d.id}</div>
        <div class="count">${d.packetCount}</div>
        <div class="label">${d.hasInternet ? 'has signal · bridge' : 'offline · holding packets'}</div>
      </div>`
    )
    .join('');
}

async function refreshAll() {
  await Promise.all([refreshAccounts(), refreshTransactions(), refreshMesh()]);
}

async function checkBackend() {
  try {
    const { publicKey } = await api('/server-key');
    el('serverKey').textContent = publicKey;
    el('connDot').className = 'dot up';
    el('connLabel').textContent = 'backend online';
  } catch (err) {
    el('connDot').className = 'dot down';
    el('connLabel').textContent = 'backend unreachable';
  }
}

el('composeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {
    sender: form.get('sender'),
    receiver: form.get('receiver'),
    amount: Number(form.get('amount')),
    pin: form.get('pin')
  };
  try {
    setFeedback('composeFeedback', 'encrypting + injecting…', 'wait');
    const { packet } = await api('/demo/send', { method: 'POST', body: JSON.stringify(body) });
    setFeedback('composeFeedback', `packet ${packet.packetId.slice(0, 8)}… handed to phone-alice`, 'ok');
    await refreshMesh();
  } catch (err) {
    setFeedback('composeFeedback', err.message, 'bad');
  }
});

el('gossipBtn').addEventListener('click', async () => {
  try {
    setFeedback('meshFeedback', 'running gossip round…', 'wait');
    await api('/mesh/gossip', { method: 'POST' });
    await refreshMesh();
    setFeedback('meshFeedback', 'gossip round complete', 'ok');
  } catch (err) {
    setFeedback('meshFeedback', err.message, 'bad');
  }
});

el('flushBtn').addEventListener('click', async () => {
  try {
    setFeedback('meshFeedback', 'bridge uploading…', 'wait');
    const { results } = await api('/mesh/flush', { method: 'POST' });
    await refreshAll();
    if (results.length === 0) {
      setFeedback('meshFeedback', 'no bridge is currently holding a packet', 'wait');
    } else {
      const summary = results.map((r) => r.outcome).join(', ');
      setFeedback('meshFeedback', `uploaded ${results.length} packet(s): ${summary}`, 'ok');
    }
  } catch (err) {
    setFeedback('meshFeedback', err.message, 'bad');
  }
});

el('resetBtn').addEventListener('click', async () => {
  try {
    await api('/mesh/reset', { method: 'POST' });
    await refreshAll();
    setFeedback('meshFeedback', 'mesh, accounts and idempotency cache reset', 'ok');
  } catch (err) {
    setFeedback('meshFeedback', err.message, 'bad');
  }
});

(async function boot() {
  await checkBackend();
  await refreshAll();
})();
