'use strict';

const express = require('express');
const { transaction } = require('../db');
const { ApiError } = require('../lib/errors');
const merchants = require('../services/merchants');
const wallets = require('../services/wallets');
const intents = require('../services/intents');
const devices = require('../services/devices');
const reviews = require('../services/reviews');
const events = require('../services/events');
const ingest = require('../services/ingest');
const { merchantAuth } = require('../middleware/auth');

/** API utilisée par le SERVEUR du marchand. Toutes les requêtes sont signées (HMAC). */
function merchantRoutes(ctx) {
  const r = express.Router();
  r.use(merchantAuth(ctx));
  const tx = (fn) => transaction(ctx.db, fn);

  // --- Compte marchand -------------------------------------------------------
  r.get('/merchant', (req, res) => {
    res.json(merchants.serializeMerchant(req.merchant));
  });

  r.patch('/merchant', (req, res) => {
    res.json(tx(() => merchants.updateMerchant(ctx, req.merchant, req.body || {})));
  });

  // --- Portefeuilles Mobile Money --------------------------------------------
  r.post('/wallets', (req, res) => {
    res.status(201).json(tx(() => wallets.createWallet(ctx, req.merchant, req.body || {})));
  });

  r.get('/wallets', (req, res) => {
    res.json({ data: wallets.listWallets(ctx, req.merchant.id).map(wallets.serializeWallet) });
  });

  // Le marchand indique son solde réel actuel (après un retrait non détecté, par exemple).
  r.post('/wallets/:id/resync', (req, res) => {
    const out = tx(() => {
      const wallet = wallets.getMerchantWallet(ctx, req.merchant.id, req.params.id);
      const balance = wallets.validateBalance((req.body || {}).balance);
      wallets.setBalance(ctx, wallet.id, balance);
      ingest.reprocessHeld(ctx, wallet.id);
      return wallets.serializeWallet(wallets.getWallet(ctx, wallet.id));
    });
    res.json(out);
  });

  // --- Intentions de paiement ------------------------------------------------
  r.post('/payment-intents', (req, res) => {
    const { intent, created } = tx(() => intents.createIntent(ctx, req.merchant, req.body || {}));
    res.status(created ? 201 : 200).json(intents.serializeIntent(ctx, intent, { withInstructions: true }));
  });

  r.get('/payment-intents', (req, res) => {
    const reference = req.query.reference;
    if (typeof reference !== 'string' || !reference) {
      throw new ApiError(400, 'missing_reference', 'Paramètre ?reference= obligatoire');
    }
    const row = intents.findByReference(ctx, req.merchant.id, reference);
    if (!row) throw new ApiError(404, 'intent_not_found', 'Intention de paiement introuvable');
    res.json(intents.serializeIntent(ctx, row, { withInstructions: true }));
  });

  r.get('/payment-intents/:id', (req, res) => {
    const row = intents.getMerchantIntent(ctx, req.merchant.id, req.params.id);
    res.json(intents.serializeIntent(ctx, row, { withInstructions: true }));
  });

  r.post('/payment-intents/:id/cancel', (req, res) => {
    const row = tx(() => intents.cancelIntent(ctx, req.merchant.id, req.params.id));
    res.json(intents.serializeIntent(ctx, row));
  });

  // --- Téléphones (application Android) --------------------------------------
  r.post('/devices/pairing-codes', (req, res) => {
    res.status(201).json(tx(() => devices.createPairingCode(ctx, req.merchant)));
  });

  r.get('/devices', (req, res) => {
    res.json({ data: devices.listDevices(ctx, req.merchant.id) });
  });

  r.post('/devices/:id/revoke', (req, res) => {
    res.json(tx(() => devices.revokeDevice(ctx, req.merchant.id, req.params.id)));
  });

  // --- Vérifications manuelles -----------------------------------------------
  r.get('/reviews', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    if (!['open', 'resolved', 'all'].includes(status)) throw new ApiError(400, 'invalid_status', 'status : open, resolved ou all');
    res.json({ data: reviews.listReviews(ctx, req.merchant.id, { status, limit: req.query.limit }) });
  });

  r.get('/reviews/:id', (req, res) => {
    res.json(reviews.serializeReview(ctx, reviews.getMerchantReview(ctx, req.merchant.id, req.params.id)));
  });

  r.post('/reviews/:id/resolve', (req, res) => {
    const row = tx(() => reviews.resolveReview(ctx, req.merchant.id, req.params.id, req.body || {}));
    res.json(reviews.serializeReview(ctx, row));
  });

  // --- Journal : SMS reçus et webhooks ---------------------------------------
  r.get('/messages', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ data: ingest.listMessages(ctx, req.merchant.id, { status, limit: req.query.limit }) });
  });

  r.get('/events', (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    res.json({ data: events.listEvents(ctx, req.merchant.id, { type, limit: req.query.limit }) });
  });

  r.post('/events/:id/retry', (req, res) => {
    res.json(tx(() => events.retryEvent(ctx, req.merchant.id, req.params.id)));
  });

  return r;
}

module.exports = { merchantRoutes };
