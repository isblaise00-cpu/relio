'use strict';

const crypto = require('node:crypto');

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`La variable d'environnement ${name} doit être un nombre`);
  return n;
}

/**
 * Charge la configuration depuis les variables d'environnement.
 * `overrides` permet aux tests d'imposer des valeurs.
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: readInt('PORT', 3000),
    dbPath: env.DB_PATH || './data/smspay.db',
    nodeEnv: env.NODE_ENV || 'development',
    masterKey: env.MASTER_KEY || '',
    adminToken: env.ADMIN_TOKEN || '',
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '226',
    signatureToleranceS: readInt('SIGNATURE_TOLERANCE_S', 300),
    holdSeconds: readInt('HOLD_SECONDS', 120),
    deviceOfflineAfterS: readInt('DEVICE_OFFLINE_AFTER_S', 300),
    workerIntervalMs: readInt('WORKER_INTERVAL_MS', 2000),
    matchClockSkewS: readInt('MATCH_CLOCK_SKEW_S', 120),
    intentDefaultTtlS: readInt('INTENT_DEFAULT_TTL_S', 900),
    maxAmount: readInt('MAX_AMOUNT', 2000000),
    webhookTimeoutMs: readInt('WEBHOOK_TIMEOUT_MS', 10000),
    pairingCodeTtlS: readInt('PAIRING_CODE_TTL_S', 600),
    heartbeatIntervalS: readInt('HEARTBEAT_INTERVAL_S', 60),
    quiet: false,
    ...overrides,
  };

  cfg.masterKeyBuf = resolveMasterKey(cfg);
  return cfg;
}

function resolveMasterKey(cfg) {
  if (cfg.masterKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(cfg.masterKey)) {
      throw new Error('MASTER_KEY doit contenir exactement 64 caractères hexadécimaux (32 octets)');
    }
    return Buffer.from(cfg.masterKey, 'hex');
  }
  if (cfg.nodeEnv === 'production') {
    throw new Error('MASTER_KEY est obligatoire en production');
  }
  if (!cfg.quiet) {
    console.warn('[config] MASTER_KEY absente : clé de développement NON SÉCURISÉE utilisée.');
  }
  return crypto.createHash('sha256').update('smspay-dev-insecure-master-key').digest();
}

module.exports = { loadConfig };
