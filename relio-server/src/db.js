'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  api_key            TEXT NOT NULL UNIQUE,
  api_secret_enc     TEXT NOT NULL,
  webhook_url        TEXT,
  webhook_secret_enc TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         INTEGER NOT NULL
);

-- Portefeuilles Mobile Money du marchand (une SIM = un numéro par opérateur).
-- "balance" est le dernier solde connu et VÉRIFIÉ : c'est la base du contrôle
-- de continuité des soldes (anti-faux SMS).
CREATE TABLE IF NOT EXISTS wallets (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  operator           TEXT NOT NULL,
  msisdn             TEXT NOT NULL,
  label              TEXT,
  balance            INTEGER,
  balance_updated_at INTEGER,
  sync_status        TEXT NOT NULL DEFAULT 'unsynced',
  created_at         INTEGER NOT NULL,
  UNIQUE (merchant_id, operator, msisdn)
);

CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL REFERENCES merchants(id),
  name             TEXT NOT NULL,
  secret_enc       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  last_seen_at     INTEGER,
  last_heartbeat   TEXT,
  offline_notified INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code        TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  device_id   TEXT
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  reference      TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'XOF',
  payer_msisdn   TEXT NOT NULL,
  operator       TEXT,
  status         TEXT NOT NULL,
  confirmation   TEXT,
  sms_id         TEXT,
  transaction_id TEXT,
  metadata       TEXT,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  succeeded_at   INTEGER,
  canceled_at    INTEGER,
  expired_at     INTEGER,
  UNIQUE (merchant_id, reference)
);
CREATE INDEX IF NOT EXISTS ix_intents_match  ON payment_intents (merchant_id, payer_msisdn, status, amount);
CREATE INDEX IF NOT EXISTS ix_intents_expiry ON payment_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS sms_messages (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  device_msg_id       TEXT NOT NULL,
  sender              TEXT NOT NULL,
  body                TEXT NOT NULL,
  sim_slot            INTEGER,
  sim_msisdn          TEXT,
  device_received_at  INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  template_id         TEXT,
  operator            TEXT,
  kind                TEXT,
  amount              INTEGER,
  fee                 INTEGER,
  payer_msisdn        TEXT,
  new_balance         INTEGER,
  transaction_id      TEXT,
  wallet_id           TEXT,
  status              TEXT NOT NULL,
  reasons             TEXT,
  candidate_intent_id TEXT,
  intent_id           TEXT,
  hold_until          INTEGER,
  UNIQUE (device_id, device_msg_id)
);
CREATE INDEX IF NOT EXISTS ix_sms_txn    ON sms_messages (operator, transaction_id);
CREATE INDEX IF NOT EXISTS ix_sms_held   ON sms_messages (status, hold_until);
CREATE INDEX IF NOT EXISTS ix_sms_wallet ON sms_messages (wallet_id, status);

CREATE TABLE IF NOT EXISTS reviews (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL,
  sms_id              TEXT NOT NULL,
  candidate_intent_id TEXT,
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  resolution          TEXT,
  resolved_intent_id  TEXT,
  note                TEXT,
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_reviews_merchant ON reviews (merchant_id, status, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id               TEXT PRIMARY KEY,
  merchant_id      TEXT NOT NULL,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  last_error       TEXT,
  last_status_code INTEGER,
  created_at       INTEGER NOT NULL,
  delivered_at     INTEGER
);
CREATE INDEX IF NOT EXISTS ix_events_due      ON webhook_events (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_events_merchant ON webhook_events (merchant_id, created_at);

CREATE TABLE IF NOT EXISTS api_nonces (
  principal  TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (principal, nonce)
);

CREATE TABLE IF NOT EXISTS parser_templates (
  id          TEXT PRIMARY KEY,
  operator    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  senders     TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  flags       TEXT NOT NULL DEFAULT 'i',
  priority    INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  example     TEXT,
  updated_at  INTEGER NOT NULL,
  operator_id TEXT REFERENCES operators(id)
);

CREATE TABLE IF NOT EXISTS operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#D2D9B6',
  country    TEXT NOT NULL DEFAULT 'BF',
  senders    TEXT NOT NULL DEFAULT '[]',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_operators (
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  operator_id    TEXT NOT NULL REFERENCES operators(id),
  recipient_name TEXT,
  PRIMARY KEY (merchant_id, operator_id)
);
`;

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Ajouts de colonnes sur une base existante (sans perte de données). */
function migrate(db) {
  const smsCols = db.prepare('PRAGMA table_info(sms_messages)').all().map((c) => c.name);
  if (!smsCols.includes('source')) {
    db.exec(`ALTER TABLE sms_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'live'`);
  }
  const merchantCols = db.prepare('PRAGMA table_info(merchants)').all().map((c) => c.name);
  if (!merchantCols.includes('webhook_success')) {
    db.exec(`ALTER TABLE merchants ADD COLUMN webhook_success TEXT`);
  }
  if (!merchantCols.includes('webhook_failure')) {
    db.exec(`ALTER TABLE merchants ADD COLUMN webhook_failure TEXT`);
  }
  const templateCols = db.prepare('PRAGMA table_info(parser_templates)').all().map((c) => c.name);
  if (!templateCols.includes('operator_id')) {
    db.exec(`ALTER TABLE parser_templates ADD COLUMN operator_id TEXT REFERENCES operators(id)`);
  }
  if (!smsCols.includes('payer_name')) {
    db.exec(`ALTER TABLE sms_messages ADD COLUMN payer_name TEXT`);
  }
  const merchantCols2 = db.prepare('PRAGMA table_info(merchants)').all().map((c) => c.name);
  if (!merchantCols2.includes('phone')) {
    db.exec(`ALTER TABLE merchants ADD COLUMN phone TEXT`);
  }
}

/** Exécute fn dans une transaction. Ne pas imbriquer. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
