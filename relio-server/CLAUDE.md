# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                  # Start server on :3000
npm run dev                # Start with --watch (auto-restart on file changes)
npm test                   # Run all 45 tests (sequential, --test-concurrency=1)
npm run create-merchant    # CLI: create a merchant directly without API
npm run demo               # End-to-end demo: payment flow + fraud attempt
npm run webhook-receiver   # Run example webhook server
```

To run a single test file:
```bash
node --test test/unit.test.js
node --test test/payment-flow.test.js
node --test test/security-and-ops.test.js
```

No build step, no TypeScript, no linter — pure Node.js 22.13+ source.

## Architecture

**SmsPay** is an automated payment confirmation system for Mobile Money (Orange Money, Moov Money) in Burkina Faso. Merchants connect an Android device; the server reads incoming SMS, detects valid payment credits, matches them to payment intents, and fires webhooks — all without holding funds.

### Request lifecycle

```
Android device → POST /device/v1/sms
                      ↓
               ingest.js (ingestOne)
                 1. Sender whitelist check (wallets table, parser_templates)
                 2. Regex template matching → parse amount, payer, balance, txn_id
                 3. Duplicate txn_id check
                 4. Balance continuity: old_balance + amount == new_balance
                 5. Intent matching: same payer MSISDN, same amount, pending + not expired
                      ↓
               Decision: matched → webhook | review → manual | held → retry | rejected
```

### Key source files

| File | Role |
|------|------|
| `src/server.js` | Entry point; wires Express routes, DB init, background workers |
| `src/app.js` | Express app factory + error handling |
| `src/db.js` | SQLite setup (WAL mode, foreign keys, schema migrations) |
| `src/workers.js` | Background loop: expire intents, promote held SMS, deliver webhooks |
| `src/services/ingest.js` | **Core**: SMS authentication, fraud detection, intent matching |
| `src/services/parser.js` | Regex template matching; parses credit vs. debit SMS fields |
| `src/services/intents.js` | Create/expire/match payment intents |
| `src/services/reviews.js` | Manual verification workflow for ambiguous cases |
| `src/services/events.js` | Webhook event queue with exponential backoff (8 retry levels) |
| `src/services/wallets.js` | Per-merchant SIM balance tracking per operator |
| `src/services/devices.js` | Android device pairing and heartbeat/offline detection |
| `src/middleware/auth.js` | HMAC-SHA256 request verification (merchant API, device API, admin) |
| `src/lib/vault.js` | AES-256-GCM encryption for secrets at rest |
| `src/lib/signing.js` | Canonical string construction + HMAC verification |
| `src/lib/ids.js` | Prefixed ID generation (`mk_`, `dev_`, `pi_`, `evt_`, …) |
| `src/lib/format.js` | Phone number normalization, FCFA amount parsing |

### Authentication

All `/v1/*` (merchant) and `/device/v1/*` (device) requests require HMAC-SHA256 signing:

- Canonical string: `timestamp\nnonce\nMETHOD\npath?query\nsha256(rawBody)`
- Anti-replay: nonce stored in `api_nonces` table + `SIGNATURE_TOLERANCE_S` window
- Admin routes (`/admin/*`): Bearer token with timing-safe comparison

See `src/middleware/auth.js` and `src/lib/signing.js` for the implementation; `clients/node/smspay-client.js` is the canonical client reference.

### Fraud detection layers

1. **Sender whitelist** — SMS must come from known operator number
2. **Template matching** — SMS must match a registered regex template
3. **Duplicate txn_id** — Prevents replayed SMS
4. **Balance continuity** — `previous_balance + amount == new_balance` (strongest control)
5. **Held SMS** — If balance is incoherent, hold for `HOLD_SECONDS` then reprocess once the chain repairs

### Background workers

`src/workers.js` runs every `WORKER_INTERVAL_MS` (default 2s):
- Expire pending intents
- Promote held SMS when balance chain is repaired
- Mark devices offline after `DEVICE_OFFLINE_AFTER_S`
- Clean expired nonces
- Deliver webhook events with exponential backoff

### Environment variables

See `.env.example` for the full list. Critical ones:
- `MASTER_KEY` — 64 hex chars (32 bytes); required in production for AES-256-GCM secret encryption
- `ADMIN_TOKEN` — enables `/admin` routes when set
- `DB_PATH` — SQLite file path (auto-created)
- `DEFAULT_COUNTRY_CODE` — default `226` (Burkina Faso)

### Tests

Tests use Node.js native `test` module. `test/helpers.js` provides:
- In-memory SQLite DB
- `SmsPayClient` / `DeviceClient` — HMAC-signing test clients
- Webhook receiver mock

Tests must run sequentially (shared in-memory state); always pass `--test-concurrency=1`.

### Examples and clients

- `clients/node/smspay-client.js` — Production-ready Node.js merchant client (HMAC signing, device pairing)
- `examples/demo.js` — Full end-to-end scenario (create merchant → pair device → send SMS → confirm)
- `examples/webhook-receiver.js` — Reference webhook handler with signature verification
- `scripts/create-merchant.js` — Bootstrap a merchant without the API
