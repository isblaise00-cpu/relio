'use strict';

const express = require('express');
const { transaction } = require('../db');
const { ApiError } = require('../lib/errors');
const devices = require('../services/devices');
const parser = require('../services/parser');
const ingest = require('../services/ingest');
const merchants = require('../services/merchants');
const operators = require('../services/operators');
const { deviceAuth } = require('../middleware/auth');

/** Limiteur simple en mémoire contre la recherche de codes d'appairage par force brute. */
function pairingLimiter({ max = 10, windowMs = 10 * 60 * 1000 } = {}) {
  const failures = new Map();
  return {
    check(key) {
      const now = Date.now();
      const entry = failures.get(key);
      if (entry && entry.resetAt > now && entry.count >= max) {
        throw new ApiError(429, 'too_many_attempts', 'Trop de tentatives, réessayez plus tard');
      }
    },
    fail(key) {
      const now = Date.now();
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
  };
}

/** API utilisée par l'APPLICATION ANDROID installée sur le téléphone du marchand. */
function deviceRoutes(ctx) {
  const r = express.Router();
  const limiter = pairingLimiter();

  // Appairage : seule route non signée (le téléphone n'a pas encore de secret).
  r.post('/pair', (req, res) => {
    const key = req.ip || 'unknown';
    limiter.check(key);
    try {
      res.status(201).json(transaction(ctx.db, () => devices.pairDevice(ctx, req.body || {})));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_code') limiter.fail(key);
      throw err;
    }
  });

  r.use(deviceAuth(ctx));
  r.use((req, _res, next) => {
    devices.touch(ctx, req.device);
    next();
  });

  // Configuration : expéditeurs filtrés par opérateurs du marchand, infos marchand, webhooks.
  r.get('/config', (req, res) => {
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.device.merchant_id);
    const merchantOps = operators.getMerchantOperators(ctx, req.device.merchant_id);

    // Si le marchand a des opérateurs configurés → senders de ces opérateurs uniquement.
    // Sinon → fallback sur la liste globale (rétrocompatibilité).
    let senders;
    if (merchantOps.length > 0) {
      senders = [...new Set(merchantOps.flatMap((op) => op.senders))];
    } else {
      senders = parser.allowedSenders(ctx);
    }

    res.json({
      device_id: req.device.id,
      senders,
      heartbeat_interval_s: ctx.cfg.heartbeatIntervalS,
      max_batch: ingest.MAX_BATCH,
      server_time: new Date().toISOString(),
      merchant_name: merchant ? merchant.name : null,
      merchant_key: merchant ? merchant.api_key : null,
      webhook_success: merchant ? (merchant.webhook_success || null) : null,
      webhook_failure: merchant ? (merchant.webhook_failure || null) : null,
      operators: merchantOps.map((op) => ({
        id: op.id,
        name: op.name,
        recipient_name: op.recipient_name || op.name,
      })),
    });
  });

  // Mise à jour des webhooks de paiement depuis l'app Android du marchand.
  r.patch('/webhooks', (req, res) => {
    const merchant = ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(req.device.merchant_id);
    if (!merchant) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    const updated = transaction(ctx.db, () => merchants.updateWebhooksFromDevice(ctx, merchant, req.body || {}));
    res.json(updated);
  });

  r.post('/heartbeat', (req, res) => {
    const b = req.body || {};
    const heartbeat = {
      battery: Number.isFinite(b.battery) ? b.battery : null,
      charging: typeof b.charging === 'boolean' ? b.charging : null,
      network: typeof b.network === 'string' ? b.network.slice(0, 32) : null,
      app_version: typeof b.app_version === 'string' ? b.app_version.slice(0, 32) : null,
      pending_queue: Number.isInteger(b.pending_queue) ? b.pending_queue : null,
      sims: Array.isArray(b.sims) ? b.sims.slice(0, 4) : null,
      received_at: new Date().toISOString(),
    };
    devices.touch(ctx, devices.getDevice(ctx, req.device.id), Date.now(), heartbeat);
    res.json({ ok: true, server_time: new Date().toISOString() });
  });

  // Réception des SMS (par lot, idempotent grâce à l'id local de chaque SMS).
  r.post('/sms', (req, res) => {
    const results = ingest.ingestBatch(ctx, req.device, (req.body || {}).messages);
    res.json({ results });
  });

  return r;
}

module.exports = { deviceRoutes };
