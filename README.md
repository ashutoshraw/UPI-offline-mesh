# UPI Offline Mesh — Demo

A Node.js/Express backend that demonstrates **offline UPI payments routed through a Bluetooth-style mesh network**. You're in a basement with zero connectivity. You send your friend ₹500. Your phone encrypts the payment, broadcasts it to nearby phones, and the packet hops device-to-device until *some* phone walks outside, gets 4G, and silently uploads it to this backend. The backend decrypts, deduplicates, and settles.

This repo is the **server side** of that system, plus a software simulator of the mesh so you can demo the whole flow on a single laptop without any real Bluetooth hardware.

---

## Table of Contents

1. [What this demo proves](#what-this-demo-proves)
2. [How to run it](#how-to-run-it)
3. [The demo flow (step by step)](#the-demo-flow-step-by-step)
4. [Architecture](#architecture)
5. [The three hard problems and how they're solved](#the-three-hard-problems-and-how-theyre-solved)
6. [File-by-file walkthrough](#file-by-file-walkthrough)
7. [API reference](#api-reference)
8. [Tests](#tests)
9. [What's NOT real (and what would change for production)](#whats-not-real-and-what-would-change-for-production)
10. [Honest limitations of the concept](#honest-limitations-of-the-concept)
11. [Deploying to Netlify](#deploying-to-netlify)

---

## What this demo proves

The system shows three things working end to end:

1. **A payment can travel from sender to backend through untrusted intermediaries** without any of them being able to read or tamper with it. (Hybrid RSA + AES-GCM encryption.)
2. **Even if the same payment reaches the backend simultaneously through multiple bridge nodes, it settles exactly once.** (Idempotency via an atomic claim on the ciphertext hash.)
3. **A tampered or replayed packet is rejected** before it touches the ledger.

You'll see all three in the dashboard.

---

## How to run it

### Prerequisites

- **Node.js 18 or newer** installed and on PATH. Check with `node -v`.
- That's it. No database, no Redis, no build step. Just Node.

### Run it (any OS)

Open a terminal in the project folder and run:

```
npm install
npm start
```

`npm install` pulls down Express, cors, and serverless-http — a few seconds on a normal connection. Every run after that starts in under a second, since there's no compile step.

### Open the dashboard

Once you see `UPI Offline Mesh (JS) listening on http://localhost:8080`, open:

**http://localhost:8080**

You'll get a dark dashboard with everything you need to drive the demo.

### Stop the server

`Ctrl+C` in the terminal.

### Run the tests

```
npm test
```

The interesting one is `idempotency.test.js` — it fires three deliveries of the same packet at once and asserts that exactly one settles.

---

## The demo flow (step by step)

The dashboard has buttons that walk through the full pipeline. The intended sequence:

### Step 1 — Compose a payment

Choose sender, receiver, amount, PIN. Click **"Inject into mesh"**.

**What actually happens on the backend:**

- The server pretends to be the sender's phone.
- It builds a `PaymentInstruction` with a unique nonce and current timestamp.
- It encrypts that with the server's RSA public key (using hybrid encryption — see below).
- It wraps the ciphertext in a `MeshPacket` with a TTL of 5.
- It hands the packet to `phone-alice`, an offline virtual device.

You'll see `phone-alice` now holds 1 packet.

### Step 2 — Run gossip rounds

Click **"Run gossip round"**. Then click it again.

Each round, every device that holds a packet broadcasts it to every other device within "Bluetooth range" (which, in our simulator, means everyone). TTL decrements per hop.

After 1 round: every device holds the packet. After 2 rounds: still every device — TTL is just lower.

In the real system this would happen organically as people walk past each other in the basement.

### Step 3 — Bridge node walks outside

Click **"Bridges upload to backend"**.

`phone-bridge` is the only device with `hasInternet: true`. The dashboard simulates that phone walking outside and getting 4G. It POSTs every packet it holds to `/api/bridge/ingest`.

The backend pipeline runs:

1. Hash the ciphertext (`SHA-256`).
2. Try to claim the hash in the idempotency cache.
3. If claimed: decrypt with the server's RSA private key.
4. Verify freshness (`signedAt` within 24 hours).
5. Run the debit/credit and write the ledger row.

Watch the **Account Balances** table — money has moved. Watch the **Transaction Ledger** — a new row appears.

### Step 4 — Demonstrate idempotency (the killer feature)

Reset the mesh. Inject a single packet. Run gossip 2 times. Now every device holds the same packet.

To really see idempotency in action against a *live* server, fire the same packet at `/api/bridge/ingest` several times in parallel with `curl` — only one will settle, the rest come back `DUPLICATE_DROPPED`.

To exercise the concurrent-delivery case as an automated test, run:

```
node --test test/idempotency.test.js
```

This test creates one packet, delivers it three times at once, and verifies that exactly one settles, two are dropped as duplicates, and the sender is debited exactly once.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SENDER PHONE (offline)                          │
│  PaymentInstruction { sender, receiver, amount, pinHash, nonce, time }  │
│              │                                                          │
│              ▼ encrypt with server's RSA public key                     │
│   MeshPacket { packetId, ttl, createdAt, ciphertext }                   │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │ Bluetooth gossip
                                       ▼
        ┌─────────┐  hop   ┌─────────┐  hop   ┌─────────┐
        │stranger1│ ─────▶ │stranger2│ ─────▶ │ bridge  │ ◀── walks outside
        └─────────┘        └─────────┘        └────┬────┘     gets 4G
                                                   │
                                                   ▼ HTTPS POST
┌─────────────────────────────────────────────────────────────────────────┐
│                    NODE / EXPRESS BACKEND (this project)                │
│                                                                         │
│  /api/bridge/ingest                                                     │
│       │                                                                 │
│       ▼                                                                 │
│  [1] hash ciphertext (SHA-256)                                          │
│       │                                                                 │
│       ▼                                                                 │
│  [2] idempotencyService.claim(hash)  ◀── atomic Map.has/set (≈ Redis    │
│       │                                  SETNX). Duplicates rejected    │
│       │                                  here, before any work.         │
│       ▼                                                                 │
│  [3] hybridCrypto.decrypt(ciphertext)                                   │
│       │       (RSA-OAEP unwraps AES key, AES-GCM decrypts payload       │
│       │        AND verifies the auth tag — tampering = thrown error)    │
│       ▼                                                                 │
│  [4] Freshness check: signedAt within last 24h                          │
│       │                                                                 │
│       ▼                                                                 │
│  [5] settlementService.settle()                                         │
│       debit sender, credit receiver, write ledger                       │
│       Account.version bumped on write = optimistic locking              │
│       (defense in depth)                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The three hard problems and how they're solved

### Problem 1: Untrusted intermediates

A random stranger's phone is carrying your transaction. How do you stop them from reading the amount or changing it?

**Solution: Hybrid encryption (RSA-OAEP + AES-GCM).**

The sender encrypts the payload with the server's public key. Only the server holds the private key, so intermediates see opaque ciphertext.

But RSA can only encrypt small data (~245 bytes for a 2048-bit key), and our payload is JSON that could exceed that. So we use the standard hybrid pattern:

1. Generate a fresh AES-256 key for *this packet*.
2. Encrypt the JSON with **AES-256-GCM** (fast + authenticated).
3. Encrypt just the AES key with **RSA-OAEP**.
4. Concatenate: `[256 bytes RSA-encrypted AES key][12 bytes IV][AES ciphertext + 16-byte GCM tag]`.

**Why GCM specifically?** It's authenticated encryption. If an intermediate flips one bit anywhere in the ciphertext, decryption throws — the GCM tag won't verify. The server cannot be tricked into processing tampered data.

This is the same scheme TLS uses. See `src/crypto/hybridCrypto.js`, built entirely on Node's built-in `crypto` module — no external crypto dependency.

### Problem 2: The duplicate-storm

Three bridge nodes hold the same packet. They all walk outside at the same instant. They all POST to `/api/bridge/ingest` within milliseconds of each other. If you naively process all three, the sender is debited ₹1500 instead of ₹500.

**Solution: Atomic claim on the ciphertext hash.**

The very first thing the server does on receiving a packet is compute `SHA-256(ciphertext)` and try to "claim" that hash:

```js
// idempotencyService.js
function claim(packetHash) {
  if (seen.has(packetHash)) return false; // duplicate
  seen.set(packetHash, Date.now());
  return true; // first claimer
}
```

Node's event loop is single-threaded and synchronous code never yields mid-statement, so a plain `Map.has`/`.set` pair here is exactly as atomic as Java's `ConcurrentHashMap.putIfAbsent` was — three "simultaneous" HTTP requests are really three calls the event loop still handles one at a time, in some order, with the same first-wins outcome. Only the first claimer proceeds to decrypt and settle. The rest are short-circuited as `DUPLICATE_DROPPED`.

**Why hash the ciphertext, not the packetId or the cleartext?**

- `packetId` can be rewritten by a malicious intermediate. Two copies of the same payment could have different packetIds. Bad key.
- The cleartext requires decryption first. We want to dedupe *before* spending CPU on RSA.
- The ciphertext is authenticated by GCM, so any tampering is detectable on decrypt. Two legitimate deliveries of the same payment have byte-identical ciphertexts (AES is deterministic for a given key+IV+plaintext, and the same packet means the same key+IV+plaintext).

In production this `Map` becomes Redis: `SET key NX EX 86400`. Same semantics, distributed across replicas.

There's also a defense-in-depth fallback: `store.claimPacketHash()` mirrors a unique index on `packetHash` at the storage layer. If the cache layer ever fails and two settlements somehow try to write the same hash, the store rejects the second one.

### Problem 3: Replay attacks

An attacker who captured a ciphertext weeks ago could replay it whenever convenient.

**Solution: Two layers.**

1. **Inside the encrypted payload**, the sender includes `signedAt` (epoch millis). The server rejects any packet older than 24 hours. The attacker can't change `signedAt` without breaking the GCM tag.
2. **Inside the encrypted payload**, the sender includes a **nonce** (UUID). Even if Alice legitimately sends Bob ₹100 twice, the nonces differ → ciphertexts differ → hashes differ → both settle. But a *replay* of one specific signed packet is byte-identical, so the idempotency cache catches it.

See `src/services/bridgeIngestionService.js` for the freshness check.

---

## File-by-file walkthrough

```
upi-mesh-js/
├── package.json                          npm scripts + dependencies
├── server.js                             Local entrypoint: node server.js / npm start
├── netlify.toml                          Netlify build + redirects config
├── netlify/functions/api.js              Serverless wrapper around the same Express app
├── src/
│   ├── app.js                            Builds the Express app (used by server.js)
│   │
│   ├── models/                           ── Domain layer
│   │   └── store.js                      In-memory accounts + transaction ledger.
│   │                                      version field = optimistic lock,
│   │                                      claimPacketHash() = unique index on packetHash
│   │
│   ├── crypto/                           ── Cryptography layer
│   │   └── hybridCrypto.js               Generates RSA-2048 keypair on startup,
│   │                                      RSA-OAEP + AES-256-GCM encrypt/decrypt + ciphertext hash
│   │
│   ├── services/                         ── Business logic
│   │   ├── meshSimulatorService.js       Seeds devices/accounts, simulates a sender phone,
│   │   │                                 gossip protocol across virtual devices
│   │   ├── idempotencyService.js         Map = JVM-local-style Redis SETNX equivalent
│   │   ├── settlementService.js          debit + credit + ledger insert
│   │   └── bridgeIngestionService.js     THE pipeline: hash → claim → decrypt → freshness → settle
│   │
│   └── routes/
│       └── api.js                        All REST endpoints, mounted at /api
│
├── public/                               ── HTTP layer (static, served by Express or Netlify's CDN)
│   ├── index.html                        Dashboard
│   ├── style.css
│   └── dashboard.js                      Talks to /api/*
│
└── test/
    ├── hybridCrypto.test.js              Round-trip + tamper test
    └── idempotency.test.js               The 3-bridges-at-once test + tamper test
```

---

## API reference

| Method | Path                 | What it does                                        |
| ------ | -------------------- | --------------------------------------------------- |
| GET    | `/`                  | Dashboard (static files in `public/`)                |
| GET    | `/api/server-key`    | Server's RSA public key (base64)                    |
| GET    | `/api/accounts`      | All accounts and balances                           |
| GET    | `/api/transactions`  | Last 20 transactions                                |
| GET    | `/api/mesh/state`    | Current state of every virtual device               |
| POST   | `/api/demo/send`     | Simulate sender phone — encrypt + inject packet     |
| POST   | `/api/mesh/gossip`   | Run one round of gossip across the mesh             |
| POST   | `/api/mesh/flush`    | Bridges with internet upload to backend             |
| POST   | `/api/mesh/reset`    | Clear mesh, accounts and idempotency cache          |
| POST   | `/api/bridge/ingest` | **The production endpoint.** Real bridges POST here |

There's no database console in this version — the whole store is a plain JS object in `src/models/store.js`, inspectable directly if you're running with a debugger attached.

### Request format for `/api/bridge/ingest`

```
POST /api/bridge/ingest
Content-Type: application/json
X-Bridge-Node-Id: phone-bridge-42
X-Hop-Count: 3

{
  "packetId": "550e8400-e29b-41d4-a716-446655440000",
  "ttl": 2,
  "createdAt": 1730000000000,
  "ciphertext": "base64-encoded-RSA-and-AES-blob"
}
```

Response:

```
{
  "outcome": "SETTLED",                     // or "DUPLICATE_DROPPED" or "INVALID" or "REJECTED"
  "packetHash": "a3f8c9...",
  "reason": null,                            // populated on INVALID / REJECTED
  "transactionId": 42                        // populated on SETTLED
}
```

---

## Tests

Run all tests:

```
npm test
```

(equivalent to `node --test test/**/*.test.js` — uses Node's built-in test runner, no extra dependency.)

The tests included:

- **`encryptDecryptRoundTrip`** — sanity-check that hybrid encryption is symmetric.
- **`tamperedCiphertextIsRejected`** — flip a byte in the ciphertext, verify `decrypt()` throws.
- **`singlePacketDeliveredByThreeBridgesSettlesExactlyOnce`** — the headline test. One packet, three near-simultaneous deliveries. Asserts exactly one `SETTLED`, two `DUPLICATE_DROPPED`, and that the sender's balance changed by exactly the amount once.
- **`tamperedPacketIsInvalidNotSettled`** — same tamper check, but through the full ingestion pipeline rather than the crypto layer alone.

---

## What's NOT real (and what would change for production)

This is a teaching demo. To make it production-grade you'd swap these things:

| What's in the demo                                | What it would be in production                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Plain JS object store (`src/models/store.js`)       | PostgreSQL / MySQL with replicas                                              |
| `Map` for idempotency                                | Redis with `SET NX EX`                                                        |
| RSA keypair regenerated on every boot                | Private key in HSM (AWS KMS, HashiCorp Vault). Public key cached on devices.  |
| Server-side `meshSimulatorService.injectDemo()`      | Same encryption logic running on-device (React Native / native mobile)        |
| Software-simulated mesh (`meshSimulatorService.js`)  | Real BLE GATT or Wi-Fi Direct between phones                                  |
| One settlement function that owns the ledger         | Integration with NPCI / a real bank core                                      |
| No auth on `/api/bridge/ingest`                      | Mutual TLS or signed bridge-node certificates                                 |
| In-memory accounts seeded on startup                 | Real KYC'd users, real VPAs, real PIN verification against the bank            |
| No admin console                                     | Proper observability dashboard, access-controlled                              |
| No rate limiting                                     | Per-bridge-node rate limit, per-sender velocity check                          |
| Logs to console                                      | Structured logs to a SIEM, alerts on `INVALID` spikes                          |

The cryptography and idempotency code is essentially production-shaped. The infrastructure around it is what changes.

---

## Honest limitations of the concept

I want this README to be useful to you when someone reviews the project, so let's be straight about what this design **does not** solve. These are not implementation bugs — they're inherent to "no internet, anywhere in the chain":

1. **The receiver has no way to verify the sender has the funds.** When sender hands receiver a phone showing "₹500 sent," it's an IOU, not a settled payment. If the sender's account is empty when the packet finally reaches the backend, the settlement will be `REJECTED` and the receiver is out ₹500 with no recourse. *This is why real offline UPI (UPI Lite) uses a pre-funded hardware-backed wallet* — to give cryptographic proof of available funds offline.
2. **A malicious sender can double-spend offline.** With ₹500 in their account, they could send a packet to Bob in basement A, walk to basement B, and send another ₹500 to Carol. Whichever packet hits the backend first wins; the other gets `REJECTED`. Same root cause as #1.
3. **Bluetooth in real life is hard.** Background BLE on Android is heavily throttled since Android 8. iOS peripheral mode is locked down. Two strangers' phones reliably forming a GATT connection while the apps aren't actively open is genuinely difficult and a lot of energy. This demo skips that problem entirely by simulating the mesh.
4. **Privacy / liability.** A stranger carries your encrypted transaction packet on their phone. They can't read it, but its existence is metadata. In a real deployment you'd want to think about regulatory disclosures and what happens if a device is seized.

For a college / portfolio project: name the concept honestly as **"mesh-routed deferred settlement"** rather than "real-time offline UPI," and you'll have a much stronger pitch. The cryptography and idempotency work here is real engineering and worth showing off.

---

## Deploying to Netlify

`netlify.toml` is already set up: static files serve from `public/`, and `/api/*` requests redirect to a Netlify Function (`netlify/functions/api.js`) that wraps the same Express app with `serverless-http`. Pushing this repo to GitHub and connecting it in Netlify (or running `netlify deploy`) is enough to get it live.

**One real limitation worth knowing:** Netlify Functions are stateless, ephemeral containers. The in-memory keypair, accounts, mesh state, and idempotency cache only survive while the underlying container stays warm between requests — usually true for a few clicks in one browser session, but not guaranteed. A cold start gets a fresh keypair and reset accounts, silently. For a resume link people click through once, this is normally fine; for a fully-consistent hosted demo, the fix is the same one listed in the production table above — move the store and idempotency cache to a real external service (Postgres + Redis, for example).

For a demo you're driving live in an interview, running it locally with `npm start` is the more reliable option — same tradeoff the original recommended with `mvnw spring-boot:run`.

---

## Troubleshooting

**`node: command not found`** — Install Node.js 18+ from [nodejs.org](https://nodejs.org). On Windows, restart your terminal (or your machine) after installing so PATH picks it up.

**Port 8080 already in use** — Run `PORT=3000 npm start` (Mac/Linux) or `$env:PORT=3000; npm start` (PowerShell), then open `localhost:3000`.

**First `npm install` seems slow** — It's downloading Express, cors, and serverless-http — under a minute on a normal connection. After that, `npm start` boots in under a second since there's no compile step.

**Tests fail intermittently** — The concurrency test is timing-sensitive by design. If it ever flakes, run it a few times; if it consistently fails, that's worth investigating rather than ignoring.

---

## License

Demo code, no license. Use it however you want for learning.
