# UPI Offline Mesh — JavaScript/Node port

A JavaScript/Node.js port of a Spring Boot demo that simulates **offline UPI
payments routed through a Bluetooth-style mesh network**: no internet, a
payment gets encrypted, hops device-to-device, and settles once *some* device
walks outside and gets signal.

This is a straight architectural port — same wire format, same crypto scheme,
same three "hard problems" (untrusted intermediaries, duplicate-storms,
replay attacks) — rebuilt with Express instead of Spring Boot, and Node's
built-in `crypto` module instead of `javax.crypto` / `java.security`.

---

## Table of contents

1. [Run it locally in VS Code](#run-it-locally-in-vs-code)
2. [The demo flow](#the-demo-flow)
3. [Architecture](#architecture)
4. [The three hard problems](#the-three-hard-problems)
5. [API reference](#api-reference)
6. [Project layout](#project-layout)
7. [Deploying to Netlify — and its real limitations](#deploying-to-netlify--and-its-real-limitations)
8. [What's not real / what would change for production](#whats-not-real--what-would-change-for-production)

---

## Run it locally in VS Code

**Prerequisites:** Node.js 18+ (`node -v` to check).

```bash
npm install
npm start
```

Open **http://localhost:8080** — that's the dashboard. `npm run dev` uses
`nodemon` for auto-restart while you edit.

No database, no Redis, no build step. Everything lives in memory, just like
the original's H2 in-memory DB.

---

## The demo flow

The dashboard has three actions that walk through the pipeline:

1. **Compose a payment.** Pick sender/receiver/amount/PIN, click "Inject into
   mesh." The backend plays the role of the sender's own phone: it builds a
   payment instruction, encrypts it with the server's RSA public key, wraps
   it in a packet, and hands it to `phone-alice`.
2. **Run gossip rounds.** Click "Run gossip round" a couple of times. Every
   device broadcasts every packet it holds to every other device (in this
   simulator, "in range" means everyone). TTL drops by one per hop.
3. **Bridge uploads.** Click "Bridges upload to backend." Only `phone-bridge`
   has signal; it POSTs every packet it's holding to `/api/bridge/ingest`.
   Watch the account balances and transaction ledger update.

Reset the mesh at any time with the ghost "Reset mesh" button — this also
clears the idempotency cache and reseeds accounts.

To see the duplicate-storm protection specifically: inject one packet, run
gossip twice (now every device holds it), then flush. Only one device has
internet in the default seed so you'll only see one upload — to really stress
it, `curl` the same packet body at `/api/bridge/ingest` several times in
parallel (see the inline comment in `bridgeIngestionService.js` for why a
plain `Map` is just as atomic here as Java's `ConcurrentHashMap` was, given
Node's single-threaded event loop).

---

## Architecture

```
SENDER PHONE (offline)
  PaymentInstruction { sender, receiver, amount, pinHash, nonce, signedAt }
        │
        ▼ encrypt with server's RSA public key
  MeshPacket { packetId, ttl, createdAt, ciphertext }
        │ Bluetooth-style gossip (simulated)
        ▼
  stranger-1 → stranger-2 → phone-bridge  ── walks outside, gets signal
                                  │
                                  ▼ HTTPS POST
EXPRESS BACKEND  (/api/bridge/ingest)
  [1] hash ciphertext (SHA-256)
  [2] idempotencyService.claim(hash)   ← Map, first-wins
  [3] hybridCrypto.decrypt(ciphertext) ← RSA-OAEP unwraps AES key,
  │                                       AES-GCM decrypts + verifies tag
  [4] freshness check: signedAt within 24h
  [5] settlementService.settle()       ← debit sender, credit receiver, ledger row
```

---

## The three hard problems

Same as the original, same solutions, ported line-for-line in spirit:

- **Untrusted intermediaries** → hybrid encryption. `HybridCryptoService`
  generates a fresh AES-256 key per packet, encrypts the JSON payload with
  AES-256-GCM (authenticated — any tampering fails decryption), then wraps
  just that AES key with RSA-OAEP(SHA-256). Wire format:
  `[256-byte RSA-wrapped AES key][12-byte IV][AES ciphertext + 16-byte GCM tag]`,
  base64-encoded. This is the same shape TLS uses, and it's byte-compatible
  in spirit with the original Java implementation (same key sizes, same IV
  length, same tag length).
- **Duplicate-storms** → `idempotencyService.claim(hash)` on the SHA-256 of
  the ciphertext, checked *before* any RSA/AES work. In production this is
  `SET key NX EX 86400` in Redis; here it's a `Map`, which is just as
  effectively atomic given Node's single-threaded event loop (see comment in
  the source). There's also a defense-in-depth unique-hash check at the
  storage layer (`store.claimPacketHash`), mirroring the original's unique
  DB index on `packetHash`.
- **Replay attacks** → two layers: a `signedAt` timestamp inside the
  encrypted payload (packets older than 24h are rejected, and an attacker
  can't forge `signedAt` without breaking the GCM tag), plus a `nonce` so two
  *legitimate* sends of the same amount produce different ciphertexts (and
  thus different hashes), while a true replay of one specific packet is
  byte-identical and gets caught by the idempotency cache.

---

## API reference

| Method | Path                  | What it does                                          |
| ------ | --------------------- | ------------------------------------------------------ |
| GET    | `/`                   | Dashboard (static files in `public/`)                 |
| GET    | `/api/server-key`     | Server's RSA public key (base64 SPKI)                 |
| GET    | `/api/accounts`       | All accounts and balances                              |
| GET    | `/api/transactions`   | Last 20 transactions                                   |
| GET    | `/api/mesh/state`     | Current state of every virtual device                  |
| POST   | `/api/demo/send`      | `{sender, receiver, amount, pin}` — inject a packet     |
| POST   | `/api/mesh/gossip`    | Run one gossip round across the mesh                    |
| POST   | `/api/mesh/flush`     | Bridges with signal upload to the backend                |
| POST   | `/api/mesh/reset`     | Clear mesh, accounts and idempotency cache                |
| POST   | `/api/bridge/ingest`  | **The production endpoint.** A `MeshPacket` JSON body.     |

Example `/api/bridge/ingest` request:

```json
POST /api/bridge/ingest
Content-Type: application/json
X-Bridge-Node-Id: phone-bridge-42

{
  "packetId": "550e8400-e29b-41d4-a716-446655440000",
  "ttl": 2,
  "createdAt": 1730000000000,
  "ciphertext": "base64-encoded-RSA-and-AES-blob"
}
```

Response:

```json
{
  "outcome": "SETTLED",
  "packetHash": "a3f8c9...",
  "reason": null,
  "transactionId": 42
}
```

`outcome` is one of `SETTLED`, `DUPLICATE_DROPPED`, `REJECTED` (insufficient
funds), or `INVALID` (decryption failed or the packet is stale).

---

## Project layout

```
upi-mesh-js/
├── package.json
├── server.js                     Local entrypoint: node server.js / npm start
├── netlify.toml                  Netlify build + redirects config
├── netlify/functions/api.js      Serverless wrapper around the same Express app
├── src/
│   ├── app.js                    Builds the Express app (used by server.js)
│   ├── crypto/
│   │   └── hybridCrypto.js       RSA-OAEP + AES-256-GCM, hashing
│   ├── models/
│   │   └── store.js              In-memory accounts + transaction ledger
│   ├── services/
│   │   ├── idempotencyService.js Duplicate-packet cache
│   │   ├── settlementService.js  Debit/credit + ledger write
│   │   ├── bridgeIngestionService.js  The 5-step pipeline
│   │   └── meshSimulatorService.js    Virtual devices + gossip protocol
│   └── routes/
│       └── api.js                Express router — matches the API table above
└── public/
    ├── index.html                 Dashboard
    ├── style.css
    └── dashboard.js               Talks to /api/*
```

---

## Deploying to Netlify — and its real limitations

`netlify.toml` is already set up: static files serve from `public/`, and
`/api/*` requests redirect to a Netlify Function
(`netlify/functions/api.js`) that wraps the same Express app with
`serverless-http`. Pushing this repo to GitHub and connecting it in Netlify
(or running `netlify deploy`) is enough to get it live.

**Be upfront about this in an interview, because it's a real limitation, not
just a caveat:** Netlify Functions are stateless, ephemeral containers (like
AWS Lambda). The in-memory RSA keypair, account balances, mesh state, and
idempotency cache in `netlify/functions/api.js` only survive while the
underlying container stays warm between requests. That's usually true for a
few clicks in one browser session, but:

- A cold start (first request in a while) gets a fresh keypair and reset
  accounts, silently.
- Netlify may route concurrent requests to *different* warm containers, each
  with its own state — so two people (or two tabs) demoing at once can see
  different account balances.

For a resume link people click through once, this is normally fine and won't
be noticed. If you want a Netlify deployment that behaves identically to the
local version every time, the honest fix (and a good "what I'd do for
production" talking point) is to move the account/transaction store and the
idempotency cache out of process memory and into a real external store —
e.g. a free-tier Postgres (Supabase, Neon) for accounts/transactions and
Upstash Redis for the idempotency cache. That mirrors exactly what the
original README's "what's NOT real" table already says about production
hardening — it's the same tradeoff, just surfaced earlier because serverless
makes in-memory state visibly fragile instead of just conceptually so.

**Recommended for a live portfolio demo:** deploy to Netlify for the link on
your resume, but mention in your README/talking points that the canonical,
fully-consistent way to run it is `npm start` locally — same as the original
project recommended `mvnw spring-boot:run`.

---

## What's NOT real / what would change for production

| What's in this demo                          | What it would be in production                                        |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| In-memory JS objects for accounts/ledger      | PostgreSQL/MySQL with replicas                                          |
| `Map` for idempotency                          | Redis with `SET NX EX`                                                  |
| RSA keypair regenerated every boot/cold-start | Private key in an HSM (AWS KMS, HashiCorp Vault); public key on devices |
| Server-side `injectDemo()`                     | Same encryption logic running on-device (React Native / native mobile) |
| Software-simulated mesh (`meshSimulatorService.js`) | Real BLE / Wi-Fi Direct between phones                              |
| One settlement function                       | Integration with NPCI / a real bank core                                |
| No auth on `/api/bridge/ingest`                | Mutual TLS or signed bridge-node certificates                            |
| No rate limiting                               | Per-bridge-node rate limits, per-sender velocity checks                  |

## Honest limitations of the concept (unchanged from the original)

1. **The receiver can't verify the sender has funds offline.** "₹500 sent" on
   a screen is an IOU until the backend confirms it. If the sender's balance
   is empty by the time the packet lands, settlement is `REJECTED` and the
   receiver has no recourse. Real offline UPI (UPI Lite) solves this with a
   pre-funded, hardware-backed wallet.
2. **A malicious sender can double-spend offline** — send the same balance to
   two different people in two different basements. Whichever packet reaches
   the backend first wins; the other gets `REJECTED`.
3. **Real Bluetooth mesh is hard.** Background BLE is heavily throttled on
   modern mobile OSes. This demo sidesteps that with a software simulator.
4. **Privacy/metadata.** A stranger's phone carries your encrypted packet.
   They can't read it, but its existence is metadata worth thinking about.

Name this project honestly as **"mesh-routed deferred settlement,"** not
"real-time offline UPI" — same advice the original gave, and it's still the
stronger, more defensible pitch for a resume/portfolio conversation.

## License

Demo code, no license. Use it however you want for learning.
