'use strict';

const path = require('node:path');
const express = require('express');
const { transaction } = require('../db');
const { ApiError } = require('../lib/errors');
const { iso } = require('../lib/format');
const merchants = require('../services/merchants');
const devices = require('../services/devices');
const operators = require('../services/operators');
const parser = require('../services/parser');
const events = require('../services/events');
const reviews = require('../services/reviews');
const { adminAuth } = require('../middleware/auth');

function adminRoutes(ctx) {
  const r = express.Router();
  const tx = (fn) => transaction(ctx.db, fn);

  // Tableau de bord public (formulaire de connexion)
  r.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
  });

  r.use(adminAuth(ctx));

  // ─── Stats ────────────────────────────────────────────────────────────────

  r.get('/stats', (_req, res) => {
    const todayMs = new Date().setHours(0, 0, 0, 0);
    const totalMerchants = ctx.db.prepare("SELECT COUNT(*) as c FROM merchants WHERE status='active'").get().c;
    const onlineDevices = ctx.db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='active' AND offline_notified=0 AND last_seen_at IS NOT NULL").get().c;
    const totalDevices = ctx.db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='active'").get().c;
    const todaySms = ctx.db.prepare('SELECT COUNT(*) as c FROM sms_messages WHERE created_at >= ?').get(todayMs).c;
    const todayMatched = ctx.db.prepare("SELECT COUNT(*) as c FROM sms_messages WHERE created_at >= ? AND status='matched'").get(todayMs).c;
    const pendingWebhooks = ctx.db.prepare("SELECT COUNT(*) as c FROM webhook_events WHERE status='pending'").get().c;
    const failedWebhooks = ctx.db.prepare("SELECT COUNT(*) as c FROM webhook_events WHERE status='failed'").get().c;
    const openReviews = ctx.db.prepare("SELECT COUNT(*) as c FROM reviews WHERE status='open'").get().c;
    const totalOperators = ctx.db.prepare("SELECT COUNT(*) as c FROM operators WHERE active=1").get().c;
    res.json({
      merchants: totalMerchants,
      devices: { online: onlineDevices, total: totalDevices },
      today: { sms: todaySms, matched: todayMatched, success_rate: todaySms > 0 ? Math.round(todayMatched / todaySms * 100) : 0 },
      webhooks: { pending: pendingWebhooks, failed: failedWebhooks },
      reviews: openReviews,
      operators: totalOperators,
    });
  });

  r.get('/stats/chart', (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const total = ctx.db.prepare('SELECT COUNT(*) as c FROM sms_messages WHERE created_at>=? AND created_at<?').get(d.getTime(), next.getTime()).c;
      const matched = ctx.db.prepare("SELECT COUNT(*) as c FROM sms_messages WHERE created_at>=? AND created_at<? AND status='matched'").get(d.getTime(), next.getTime()).c;
      daily.push({ date: d.toISOString().slice(0, 10), total, matched });
    }
    const byOperator = ctx.db.prepare("SELECT operator, COUNT(*) as c FROM sms_messages WHERE operator IS NOT NULL GROUP BY operator ORDER BY c DESC").all();
    res.json({ daily, by_operator: byOperator });
  });

  // ─── Marchands ────────────────────────────────────────────────────────────

  r.post('/merchants', (req, res) => {
    res.status(201).json(tx(() => merchants.createMerchant(ctx, req.body || {})));
  });

  r.get('/merchants', (_req, res) => {
    const rows = ctx.db.prepare("SELECT * FROM merchants WHERE status != 'deleted' ORDER BY created_at DESC").all();
    const data = rows.map((row) => {
      const m = merchants.serializeMerchant(row);
      m.devices = devices.listDevices(ctx, row.id);
      m.operators = operators.getMerchantOperators(ctx, row.id);
      return m;
    });
    res.json({ data });
  });

  r.delete('/merchants/:id', (req, res) => {
    const row = ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status!='deleted'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    tx(() => merchants.deleteMerchant(ctx, req.params.id));
    res.json({ ok: true });
  });

  r.patch('/merchants/:id/webhooks', (req, res) => {
    const row = ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.json(tx(() => merchants.updateMerchant(ctx, row, req.body || {})));
  });

  r.get('/merchants/:id/credentials', (req, res) => {
    const row = ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status!='deleted'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.json({
      id: row.id,
      name: row.name,
      api_key: row.api_key,
      api_secret: ctx.vault.decrypt(row.api_secret_enc),
      webhook_secret: ctx.vault.decrypt(row.webhook_secret_enc),
    });
  });

  r.post('/merchants/:id/pairing-code', (req, res) => {
    const row = ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.status(201).json(tx(() => devices.createPairingCode(ctx, row)));
  });

  r.get('/merchants/:id/operators', (req, res) => {
    res.json({ data: operators.getMerchantOperators(ctx, req.params.id) });
  });

  r.put('/merchants/:id/operators', (req, res) => {
    const row = ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    const entries = (req.body || {}).operators;
    if (!Array.isArray(entries)) throw new ApiError(400, 'invalid_input', 'operators doit être un tableau');
    res.json({ data: tx(() => operators.setMerchantOperators(ctx, req.params.id, entries)) });
  });

  // ─── Téléphones ───────────────────────────────────────────────────────────

  r.get('/devices', (_req, res) => {
    const rows = ctx.db.prepare(`
      SELECT d.*, m.name as merchant_name FROM devices d
      LEFT JOIN merchants m ON d.merchant_id = m.id
      WHERE d.status='active' ORDER BY d.last_seen_at DESC NULLS LAST
    `).all();
    res.json({
      data: rows.map((row) => ({
        ...devices.serializeDevice(row),
        merchant_name: row.merchant_name,
        merchant_id: row.merchant_id,
      })),
    });
  });

  r.post('/devices/:id/revoke', (req, res) => {
    const row = ctx.db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'device_not_found', 'Téléphone introuvable');
    res.json(tx(() => devices.revokeDevice(ctx, row.merchant_id, req.params.id)));
  });

  // ─── SMS ──────────────────────────────────────────────────────────────────

  r.get('/sms', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('s.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('s.merchant_id=?'); wparams.push(req.query.merchant_id); }
    if (req.query.operator) { where.push('s.operator=?'); wparams.push(req.query.operator); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = ctx.db.prepare(
      `SELECT s.*, m.name as merchant_name FROM sms_messages s
       LEFT JOIN merchants m ON s.merchant_id=m.id ${wc}
       ORDER BY s.created_at DESC, s.rowid DESC LIMIT ? OFFSET ?`
    ).all(...wparams, limit, offset);
    const { total } = ctx.db.prepare(`SELECT COUNT(*) as total FROM sms_messages s ${wc}`).get(...wparams);
    res.json({ data: rows, total, limit, offset });
  });

  // ─── Payment intents ──────────────────────────────────────────────────────

  r.get('/intents', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('p.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('p.merchant_id=?'); wparams.push(req.query.merchant_id); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = ctx.db.prepare(
      `SELECT p.*, m.name as merchant_name FROM payment_intents p
       LEFT JOIN merchants m ON p.merchant_id=m.id ${wc}
       ORDER BY p.created_at DESC, p.rowid DESC LIMIT ? OFFSET ?`
    ).all(...wparams, limit, offset);
    const { total } = ctx.db.prepare(`SELECT COUNT(*) as total FROM payment_intents p ${wc}`).get(...wparams);
    res.json({ data: rows.map((r) => ({ ...r, amount_fcfa: r.amount })), total, limit, offset });
  });

  // ─── Webhooks ────────────────────────────────────────────────────────────

  r.get('/webhooks', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('e.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('e.merchant_id=?'); wparams.push(req.query.merchant_id); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = ctx.db.prepare(
      `SELECT e.*, m.name as merchant_name FROM webhook_events e
       LEFT JOIN merchants m ON e.merchant_id=m.id ${wc}
       ORDER BY e.created_at DESC, e.rowid DESC LIMIT ? OFFSET ?`
    ).all(...wparams, limit, offset);
    const { total } = ctx.db.prepare(`SELECT COUNT(*) as total FROM webhook_events e ${wc}`).get(...wparams);
    res.json({ data: rows.map(events.serializeEvent), total, limit, offset });
  });

  r.post('/webhooks/:id/retry', (req, res) => {
    const row = ctx.db.prepare('SELECT * FROM webhook_events WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'event_not_found', 'Événement introuvable');
    res.json(tx(() => events.retryEvent(ctx, row.merchant_id, req.params.id)));
  });

  // ─── Vérifications manuelles ─────────────────────────────────────────────

  r.get('/reviews', (req, res) => {
    const status = req.query.status || 'open';
    const rows = ctx.db.prepare(
      `SELECT r.*, m.name as merchant_name FROM reviews r
       LEFT JOIN merchants m ON r.merchant_id=m.id
       WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`
    ).all(status);
    res.json({ data: rows.map((row) => reviews.serializeReview(ctx, row)) });
  });

  r.post('/reviews/:id/resolve', (req, res) => {
    const row = ctx.db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'review_not_found', 'Vérification introuvable');
    res.json(tx(() => reviews.resolveReview(ctx, row.merchant_id, req.params.id, req.body || {})));
  });

  // ─── Opérateurs ──────────────────────────────────────────────────────────

  r.get('/operators', (_req, res) => {
    res.json({ data: operators.listOperators(ctx) });
  });

  r.post('/operators', (req, res) => {
    res.status(201).json(tx(() => operators.createOperator(ctx, req.body || {})));
  });

  r.put('/operators/:id', (req, res) => {
    res.json(tx(() => operators.updateOperator(ctx, req.params.id, req.body || {})));
  });

  // ─── Templates SMS ────────────────────────────────────────────────────────

  r.get('/parsers', (_req, res) => {
    const rows = parser.listTemplates(ctx);
    res.json({ data: rows });
  });

  r.put('/parsers/:id', (req, res) => {
    const body = { ...(req.body || {}), id: req.params.id };
    res.json(parser.upsertTemplate(ctx, body));
  });

  r.delete('/parsers/:id', (req, res) => {
    tx(() => parser.deleteTemplate(ctx, req.params.id));
    res.json({ ok: true });
  });

  r.post('/parsers/test', (req, res) => {
    const { sender, body } = req.body || {};
    if (typeof sender !== 'string' || typeof body !== 'string') {
      throw new ApiError(400, 'invalid_input', 'sender et body sont obligatoires');
    }
    res.json(parser.parseSms(ctx, sender, body));
  });

  return r;
}

module.exports = { adminRoutes };
