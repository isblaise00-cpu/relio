'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createContext } = require('../src/context');
const { createApp } = require('../src/app');
const { createWorkers } = require('../src/workers');
const { SmsPayClient, DeviceClient, verifyWebhook } = require('../clients/node/smspay-client');

const ADMIN_TOKEN = 'test-admin-token-0123456789';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Petit serveur qui reçoit les webhooks comme le ferait le site du marchand. */
async function startWebhookReceiver() {
  const received = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
      res.writeHead(status).end('ok');
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    received,
    setStatus: (s) => (status = s),
    ofType: (type) => received.filter((r) => r.body.type === type),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

async function startTestServer(overrides = {}) {
  const ctx = createContext({ dbPath: ':memory:', quiet: true, adminToken: ADMIN_TOKEN, ...overrides });
  const app = createApp(ctx);
  const server = http.createServer(app);
  const port = await listen(server);
  const workers = createWorkers(ctx);
  const baseUrl = `http://127.0.0.1:${port}`;
  const receivers = [];
  return {
    ctx,
    baseUrl,
    workers,
    receivers,
    close: async () => {
      // Ferme aussi les récepteurs de webhooks restés ouverts (ex. test en échec).
      await Promise.all(receivers.map((h) => h.close()));
      await new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          ctx.db.close();
          r();
        });
      });
    },
  };
}

async function admin(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Prépare un environnement complet : marchand, portefeuille Orange avec solde connu,
 * téléphone appairé, récepteur de webhooks.
 */
async function setupMerchant(srv, { balance = 25000, walletPhone = '70000001', operator = 'orange' } = {}) {
  const hooks = await startWebhookReceiver();
  srv.receivers.push(hooks);
  const created = await admin(srv.baseUrl, 'POST', '/admin/merchants', { name: 'Boutique Test', webhook_url: hooks.url });
  if (created.status !== 201) throw new Error(`Création marchand : ${JSON.stringify(created.body)}`);
  const merchant = new SmsPayClient({ baseUrl: srv.baseUrl, apiKey: created.body.api_key, apiSecret: created.body.api_secret });
  const wallet = await merchant.createWallet({ operator, phone: walletPhone, balance });
  const { code } = await merchant.createPairingCode();
  const { client: device } = await DeviceClient.pair(srv.baseUrl, code, 'Tecno du magasin');
  return { hooks, merchant, device, wallet, webhookSecret: created.body.webhook_secret, creds: created.body };
}

/** Envoie un SMS depuis le "téléphone" et renvoie le résultat de traitement. */
async function sendSms(device, sender, body, extra = {}) {
  const id = extra.id || crypto.randomUUID();
  const out = await device.sendSms([{ id, sender, body, received_at: extra.received_at ?? Date.now(), ...extra }]);
  return out.results[0];
}

module.exports = { ADMIN_TOKEN, startTestServer, startWebhookReceiver, setupMerchant, sendSms, admin, verifyWebhook };
