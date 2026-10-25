'use strict';

const crypto = require('node:crypto');
const { newId, newSecret } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso } = require('../lib/format');

function validateWebhookUrl(url) {
  if (url === undefined || url === null || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url doit être une URL valide');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url doit commencer par http:// ou https://');
  }
  return parsed.toString();
}

function serializeMerchant(row) {
  return {
    id: row.id,
    object: 'merchant',
    name: row.name,
    phone: row.phone || null,
    api_key: row.api_key,
    webhook_url: row.webhook_url,
    webhook_success: row.webhook_success || null,
    webhook_failure: row.webhook_failure || null,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

/** Crée un marchand. Les secrets ne sont renvoyés qu'une seule fois. */
function createMerchant(ctx, { name, phone, webhook_url } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new ApiError(400, 'invalid_name', 'name est obligatoire (100 caractères max)');
  }
  const webhookUrl = validateWebhookUrl(webhook_url);
  const phoneVal = typeof phone === 'string' && phone.trim() ? phone.trim() : null;
  const id = newId('mer');
  const apiKey = `mk_${crypto.randomBytes(16).toString('hex')}`;
  const apiSecret = newSecret('sk');
  const webhookSecret = newSecret('whsec');
  ctx.db
    .prepare(
      `INSERT INTO merchants (id, name, phone, api_key, api_secret_enc, webhook_url, webhook_secret_enc, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, name.trim(), phoneVal, apiKey, ctx.vault.encrypt(apiSecret), webhookUrl, ctx.vault.encrypt(webhookSecret), Date.now());
  const row = ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
  return {
    merchant: serializeMerchant(row),
    api_key: apiKey,
    api_secret: apiSecret,
    webhook_secret: webhookSecret,
  };
}

function findByApiKey(ctx, apiKey) {
  return ctx.db.prepare(`SELECT * FROM merchants WHERE api_key = ? AND status = 'active'`).get(apiKey) || null;
}

function updateMerchant(ctx, merchant, body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_url')) {
    const url = validateWebhookUrl(body.webhook_url);
    ctx.db.prepare('UPDATE merchants SET webhook_url = ? WHERE id = ?').run(url, merchant.id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_success')) {
    const url = validateWebhookUrl(body.webhook_success);
    ctx.db.prepare('UPDATE merchants SET webhook_success = ? WHERE id = ?').run(url, merchant.id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_failure')) {
    const url = validateWebhookUrl(body.webhook_failure);
    ctx.db.prepare('UPDATE merchants SET webhook_failure = ? WHERE id = ?').run(url, merchant.id);
  }
  return serializeMerchant(ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id));
}

/** Met à jour uniquement les webhooks de paiement, appelé depuis l'app Android du marchand. */
function updateWebhooksFromDevice(ctx, merchant, body = {}) {
  const keys = ['webhook_success', 'webhook_failure'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const url = validateWebhookUrl(body[key]);
      ctx.db.prepare(`UPDATE merchants SET ${key} = ? WHERE id = ?`).run(url, merchant.id);
    }
  }
  return serializeMerchant(ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id));
}

function deleteMerchant(ctx, id) {
  const row = ctx.db.prepare("SELECT * FROM merchants WHERE id = ? AND status != 'deleted'").get(id);
  if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
  ctx.db.prepare("UPDATE devices SET status = 'revoked' WHERE merchant_id = ? AND status = 'active'").run(id);
  ctx.db.prepare("UPDATE merchants SET status = 'deleted' WHERE id = ?").run(id);
}

module.exports = { createMerchant, findByApiKey, updateMerchant, updateWebhooksFromDevice, serializeMerchant, deleteMerchant };
