'use strict';

const { newId, newSecret, newPairingCode } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso } = require('../lib/format');
const events = require('./events');

function serializeDevice(row) {
  let heartbeat = null;
  try {
    heartbeat = row.last_heartbeat ? JSON.parse(row.last_heartbeat) : null;
  } catch {
    heartbeat = null;
  }
  return {
    id: row.id,
    object: 'device',
    name: row.name,
    status: row.status,
    online: row.status === 'active' && row.offline_notified === 0 && row.last_seen_at !== null,
    last_seen_at: iso(row.last_seen_at),
    last_heartbeat: heartbeat,
    created_at: iso(row.created_at),
  };
}

/** Le marchand génère un code à 6 chiffres à saisir dans l'application Android. */
function createPairingCode(ctx, merchant, now = Date.now()) {
  for (let i = 0; i < 10; i++) {
    const code = newPairingCode();
    const taken = ctx.db.prepare('SELECT code, expires_at, used_at FROM pairing_codes WHERE code = ?').get(code);
    if (taken && !taken.used_at && taken.expires_at > now) continue;
    if (taken) ctx.db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code);
    const expiresAt = now + ctx.cfg.pairingCodeTtlS * 1000;
    ctx.db.prepare('INSERT INTO pairing_codes (code, merchant_id, expires_at) VALUES (?, ?, ?)').run(code, merchant.id, expiresAt);
    return { code, expires_at: iso(expiresAt) };
  }
  throw new ApiError(503, 'pairing_unavailable', 'Impossible de générer un code, réessayez');
}

/** L'application Android échange le code contre un identifiant et un secret propres au téléphone. */
function pairDevice(ctx, body = {}, now = Date.now()) {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'Téléphone';
  if (!/^\d{6}$/.test(code)) throw new ApiError(400, 'invalid_code', 'code doit contenir 6 chiffres');

  const row = ctx.db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code);
  if (!row || row.used_at || row.expires_at < now) {
    throw new ApiError(400, 'invalid_code', 'Code invalide ou expiré');
  }
  const id = newId('dev');
  const secret = newSecret('ds');
  ctx.db
    .prepare(
      `INSERT INTO devices (id, merchant_id, name, secret_enc, status, last_seen_at, offline_notified, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, 0, ?)`,
    )
    .run(id, row.merchant_id, name, ctx.vault.encrypt(secret), now, now);
  ctx.db.prepare('UPDATE pairing_codes SET used_at = ?, device_id = ? WHERE code = ?').run(now, id, code);
  const merchant = ctx.db.prepare('SELECT id, name FROM merchants WHERE id = ?').get(row.merchant_id);
  events.enqueue(ctx, row.merchant_id, 'device.paired', serializeDevice(getDevice(ctx, id)), now);
  return { device_id: id, device_secret: secret, merchant: { id: merchant.id, name: merchant.name } };
}

function getDevice(ctx, id) {
  return ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) || null;
}

function findActive(ctx, id) {
  return ctx.db.prepare(`SELECT * FROM devices WHERE id = ? AND status = 'active'`).get(id) || null;
}

function listDevices(ctx, merchantId) {
  return ctx.db.prepare('SELECT * FROM devices WHERE merchant_id = ? ORDER BY created_at').all(merchantId).map(serializeDevice);
}

function revokeDevice(ctx, merchantId, id) {
  const row = ctx.db.prepare('SELECT * FROM devices WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'device_not_found', 'Téléphone introuvable');
  ctx.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(id);
  return serializeDevice(getDevice(ctx, id));
}

/** Toute requête authentifiée d'un téléphone vaut signal de vie. */
function touch(ctx, device, now = Date.now(), heartbeat) {
  if (heartbeat !== undefined) {
    const json = JSON.stringify(heartbeat).slice(0, 2000);
    ctx.db.prepare('UPDATE devices SET last_seen_at = ?, last_heartbeat = ? WHERE id = ?').run(now, json, device.id);
  } else {
    ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
  }
  if (device.offline_notified) {
    ctx.db.prepare('UPDATE devices SET offline_notified = 0 WHERE id = ?').run(device.id);
    events.enqueue(ctx, device.merchant_id, 'device.online', serializeDevice(getDevice(ctx, device.id)), now);
  }
}

/** Tâche de fond : prévient le marchand quand un téléphone ne donne plus signe de vie. */
function markOffline(ctx, now = Date.now()) {
  const limit = now - ctx.cfg.deviceOfflineAfterS * 1000;
  const rows = ctx.db
    .prepare(`SELECT * FROM devices WHERE status = 'active' AND offline_notified = 0 AND last_seen_at IS NOT NULL AND last_seen_at < ?`)
    .all(limit);
  for (const row of rows) {
    ctx.db.prepare('UPDATE devices SET offline_notified = 1 WHERE id = ?').run(row.id);
    events.enqueue(ctx, row.merchant_id, 'device.offline', serializeDevice(getDevice(ctx, row.id)), now);
  }
  return rows.length;
}

module.exports = { serializeDevice, createPairingCode, pairDevice, getDevice, findActive, listDevices, revokeDevice, touch, markOffline };
