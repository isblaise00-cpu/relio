# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

```
relio/
  relio-server/   # Node.js payment confirmation backend (SmsPay)
  relio-app/      # Kotlin/Android SMS gateway app
```

Each subproject has its own `CLAUDE.md` with details. The two are deployed together: the Android app relays SMS events to the server.

---

## relio-server — Node.js backend

### Commands

```bash
cd relio-server
npm install
cp .env.example .env        # set ADMIN_TOKEN, MASTER_KEY

npm start                   # server on :3000
npm run dev                 # auto-restart on file changes
npm test                    # all tests (sequential)

# Single test file
node --test test/unit.test.js
node --test test/payment-flow.test.js
node --test test/security-and-ops.test.js

# Utilities
npm run create-merchant -- --name "Shop" --webhook-url https://...
npm run demo                # full e2e: create merchant → pair device → send SMS → confirm
npm run webhook-receiver    # example webhook handler for local testing
```

No build step, no TypeScript, no linter — pure Node.js 22.13+.

### Architecture

SmsPay receives Mobile Money SMS forwarded by an Android device, authenticates them, matches them to payment intents, and fires webhooks — without holding funds.

**Request lifecycle:**
```
Android device → POST /device/v1/sms
                      ↓
               src/services/ingest.js (ingestOne)
                 1. Sender whitelist check (wallets table + parser templates)
                 2. Regex template matching → parse amount, payer, balance, txn_id
                 3. Duplicate txn_id check
                 4. Balance continuity: previous_balance + amount == new_balance
                 5. Intent matching: same payer MSISDN, same amount, pending + not expired
                      ↓
               Decision: matched → webhook | review → manual | held → retry | rejected
```

**Key source files:**

| File | Role |
|------|------|
| `src/server.js` | Entry point; wires Express routes, DB, background workers |
| `src/app.js` | Express app factory + error handling |
| `src/db.js` | SQLite setup (WAL mode, foreign keys, schema + migrations) |
| `src/workers.js` | Background loop: expire intents, promote held SMS, deliver webhooks |
| `src/context.js` | Global context injection |
| `src/services/ingest.js` | **Core**: SMS authentication, fraud detection, intent matching |
| `src/services/parser.js` | Regex template matching; parses credit vs. debit SMS fields |
| `src/services/intents.js` | Create/expire/match payment intents |
| `src/services/events.js` | Webhook event queue with exponential backoff (8 retry levels) |
| `src/services/wallets.js` | Per-merchant SIM balance tracking per operator |
| `src/services/devices.js` | Android device pairing and heartbeat/offline detection |
| `src/services/reviews.js` | Manual verification workflow for ambiguous cases |
| `src/middleware/auth.js` | HMAC-SHA256 request verification (merchant, device, admin) |
| `src/lib/signing.js` | Canonical string construction + HMAC verification |
| `src/lib/vault.js` | AES-256-GCM encryption for secrets at rest |
| `src/lib/ids.js` | Prefixed ID generation (`mk_`, `dev_`, `pi_`, `evt_`, …) |
| `src/lib/format.js` | Phone number normalization, FCFA amount parsing |
| `src/routes/merchant.js` | `POST /v1/payment-intents`, wallets, reviews |
| `src/routes/device.js` | `POST /device/v1/sms`, heartbeat, pairing |
| `src/routes/admin.js` | `POST /admin/parsers`, test SMS against templates |

**Authentication (all `/v1/*` and `/device/v1/*`):**
- Canonical string: `timestamp\nnonce\nMETHOD\npath?query\nsha256(rawBody)`
- Anti-replay: nonce stored in `api_nonces` + `SIGNATURE_TOLERANCE_S` window (±300 s)
- Admin routes: Bearer token with timing-safe comparison
- Reference implementation: `clients/node/smspay-client.js`

**Fraud detection layers (in order):**
1. Sender whitelist — SMS from known operator number only
2. Template matching — must match a registered regex
3. Duplicate `txn_id` — prevents replayed SMS
4. Balance continuity — `prev_balance + amount == new_balance` (strongest control)
5. Held SMS — incoherent balance holds for `HOLD_SECONDS`; auto-retried when chain repairs

**Background workers** (`src/workers.js`, every `WORKER_INTERVAL_MS` = 2 s default):
- Expire pending intents
- Promote held SMS when balance chain repairs
- Mark devices offline after `DEVICE_OFFLINE_AFTER_S` (default 300 s)
- Clean expired nonces
- Deliver webhooks with exponential backoff (10 s → 30 s → 2 m → 10 m → 30 m → 1 h → 3 h → 6 h)

**Environment variables** (see `.env.example`):
- `MASTER_KEY` — 64 hex chars; required in production for AES-256-GCM secret encryption
- `ADMIN_TOKEN` — enables `/admin` routes
- `DB_PATH` — SQLite file path (auto-created)
- `DEFAULT_COUNTRY_CODE` — default `226` (Burkina Faso)

**Tests** use Node.js native `test` module. `test/helpers.js` provides in-memory SQLite, HMAC-signing test clients, and a webhook mock. Always run with `--test-concurrency=1` (shared in-memory state).

---

## relio-app — Kotlin/Android SMS gateway

### Commands

```bash
cd relio-app

./gradlew test                # unit tests
./gradlew assembleDebug       # debug APK (TLS only)
./gradlew assembleInsecure    # debug APK allowing cleartext (dev only)
./gradlew assembleRelease     # signed release APK
./gradlew bundleRelease       # release .aab
```

Prerequisites: JDK 17, Android SDK, `app/google-services.json` (Firebase), `app/keystore.jks` (release signing).

Release signing env vars: `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD`.

### Architecture

The app forwards received SMS to the SmsPay server. It can operate in **local mode** (embedded Ktor HTTP server, no cloud) or **cloud mode** (Firebase FCM + cloud device pairing).

**Module layout** (`app/src/main/java/me/capcom/smsgateway/`):

| Package | Role |
|---------|------|
| `modules/gateway/` | Core gateway service; handles API requests in both modes |
| `modules/device/` | Cloud device pairing + heartbeat |
| `modules/localserver/` | Embedded Ktor HTTP server for local mode |
| `modules/incoming/` | Receives SMS from Android system |
| `modules/receiver/` | Broadcast receivers for SMS/MMS events |
| `modules/messages/` | Message state machine |
| `modules/webhooks/` | Webhook delivery + retry logic |
| `modules/mms/` | MMS handling, PDU parsing |
| `modules/encryption/` | End-to-end encryption |
| `modules/orchestrator/` | Startup sequence coordination |
| `modules/ping/` | Periodic health checks |
| `data/` | Room DB (`AppDatabase.kt`), DAOs, entities, migrations |

**DI:** Koin — modules registered in `App.kt`.

**Key flows:**
- SMS received → broadcast receiver → message state machine → forwarded to server via HTTP
- Device pairing → 6-digit code exchange → generates `device_id` + `secret`
- Webhook delivery → queued in Room DB, retried with backoff via WorkManager

**Build variants:**

| Variant | Keystore | Network | Use |
|---------|----------|---------|-----|
| `debug` | Debug | TLS only | Development |
| `debugInsecure` | Debug | Cleartext | Development + local HTTP |
| `insecure` | Release | Cleartext | Testing (never production) |
| `release` | Release | TLS only | Production |
