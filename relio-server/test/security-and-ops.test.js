'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer, setupMerchant, sendSms, admin } = require('./helpers');
const { SmsPayClient, DeviceClient } = require('../clients/node/smspay-client');
const { signRequest } = require('../src/lib/signing');
const samples = require('../examples/sms-samples');

async function rawSigned(baseUrl, { apiKey, secret, method, path, body, timestamp, nonce, tamperBody }) {
  const rawBody = body ? JSON.stringify(body) : '';
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const sig = signRequest(secret, { timestamp: ts, nonce: n, method, path, rawBody });
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'x-api-key': apiKey, 'x-timestamp': ts, 'x-nonce': n, 'x-signature': sig, 'content-type': 'application/json' },
    body: tamperBody ? tamperBody : rawBody || undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe('Sécurité de l\'API', () => {
  let srv;
  let env;
  before(async () => {
    srv = await startTestServer();
    env = await setupMerchant(srv);
  });
  after(async () => {
    await env.hooks.close();
    await srv.close();
  });

  const creds = () => ({ apiKey: env.creds.api_key, secret: env.creds.api_secret });

  test('requête sans signature => 401', async () => {
    const res = await fetch(`${srv.baseUrl}/v1/wallets`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'missing_auth');
  });

  test('mauvais secret => 401', async () => {
    const res = await rawSigned(srv.baseUrl, { apiKey: env.creds.api_key, secret: 'faux', method: 'GET', path: '/v1/wallets' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'invalid_signature');
  });

  test('corps modifié après signature => 401', async () => {
    const res = await rawSigned(srv.baseUrl, {
      ...creds(),
      method: 'POST',
      path: '/v1/payment-intents',
      body: { reference: 'X-1', amount: 100, payer_phone: '70123456' },
      tamperBody: JSON.stringify({ reference: 'X-1', amount: 1, payer_phone: '70123456' }),
    });
    assert.equal(res.status, 401);
  });

  test('rejeu d\'une requête (même nonce) => 401', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Math.floor(Date.now() / 1000).toString();
    const first = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', nonce, timestamp: ts });
    assert.equal(first.status, 200);
    const replay = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', nonce, timestamp: ts });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'replayed_request');
  });

  test('requête trop ancienne => 401', async () => {
    const old = (Math.floor(Date.now() / 1000) - 3600).toString();
    const res = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', timestamp: old });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'stale_request');
  });

  test('un marchand ne voit pas les intentions d\'un autre', async () => {
    const other = await setupMerchant(srv);
    const intent = await env.merchant.createPaymentIntent({ reference: 'ISO-1', amount: 1234, payer_phone: '70123456' });
    await assert.rejects(other.merchant.getPaymentIntent(intent.id), { status: 404 });
    await other.hooks.close();
  });

  test('un téléphone ne peut pas utiliser la clé d\'un marchand, ni l\'inverse', async () => {
    const fakeDevice = new DeviceClient({ baseUrl: srv.baseUrl, deviceId: env.creds.api_key, deviceSecret: env.creds.api_secret });
    await assert.rejects(fakeDevice.getConfig(), { status: 401 });
  });

  test('téléphone révoqué => 401', async () => {
    const { code } = await env.merchant.createPairingCode();
    const { client, device_id } = await DeviceClient.pair(srv.baseUrl, code);
    await client.getConfig();
    await env.merchant.revokeDevice(device_id);
    await assert.rejects(client.getConfig(), { status: 401 });
  });

  test('routes admin protégées par jeton', async () => {
    const res = await fetch(`${srv.baseUrl}/admin/merchants`, { headers: { authorization: 'Bearer mauvais' } });
    assert.equal(res.status, 401);
  });

  test('validation des entrées', async () => {
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-1', amount: -5, payer_phone: '70123456' }), { code: 'invalid_amount' });
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-2', amount: 100, payer_phone: '12' }), { code: 'invalid_payer_phone' });
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-3', amount: 100, payer_phone: '70123456', operator: 'wave' }), {
      code: 'invalid_operator',
    });
    await assert.rejects(env.merchant.createPaymentIntent({ amount: 100, payer_phone: '70123456' }), { code: 'invalid_reference' });
  });
});

describe('Appairage, téléphones et webhooks', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('code d\'appairage à usage unique', async () => {
    const env = await setupMerchant(srv);
    const { code } = await env.merchant.createPairingCode();
    await DeviceClient.pair(srv.baseUrl, code);
    await assert.rejects(DeviceClient.pair(srv.baseUrl, code), { code: 'invalid_code' });
    await env.hooks.close();
  });

  test('le téléphone reçoit la liste des expéditeurs à surveiller', async () => {
    const env = await setupMerchant(srv);
    const cfg = await env.device.getConfig();
    assert.ok(cfg.senders.includes('OrangeMoney'));
    assert.ok(cfg.senders.includes('MoovMoney'));
    await env.hooks.close();
  });

  test('téléphone silencieux => webhook device.offline, puis device.online au retour', async () => {
    const env = await setupMerchant(srv);
    await env.device.heartbeat({ battery: 80, charging: true, network: '4G' });
    const devicesList = await env.merchant.listDevices();
    assert.equal(devicesList.data[0].last_heartbeat.battery, 80);

    await srv.workers.runOnce(Date.now() + (srv.ctx.cfg.deviceOfflineAfterS + 5) * 1000);
    assert.equal(env.hooks.ofType('device.offline').length, 1);

    await env.device.heartbeat({ battery: 79 });
    await srv.workers.runOnce();
    assert.equal(env.hooks.ofType('device.online').length, 1);
    await env.hooks.close();
  });

  test('webhook en échec => nouvelles tentatives jusqu\'à succès', async () => {
    const env = await setupMerchant(srv, { balance: 1000 });
    env.hooks.setStatus(500);
    await env.merchant.createPaymentIntent({ reference: 'WH-1', amount: 500, payer_phone: '70123456' });
    await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 500, payer: '70123456', balance: 1500, txn: samples.txnId() }));

    await srv.workers.runOnce();
    let [evt] = (await env.merchant.listEvents({ type: 'payment_intent.succeeded' })).data;
    assert.equal(evt.status, 'pending');
    assert.equal(evt.attempts, 1);
    assert.equal(evt.last_status_code, 500);

    env.hooks.setStatus(200);
    await srv.workers.runOnce(Date.now() + 11 * 1000);
    [evt] = (await env.merchant.listEvents({ type: 'payment_intent.succeeded' })).data;
    assert.equal(evt.status, 'delivered');
    assert.equal(evt.attempts, 2);
    assert.equal(env.hooks.ofType('payment_intent.succeeded').length, 2);
    await env.hooks.close();
  });

  test('mise à jour d\'un modèle de SMS via l\'API admin (sans republier l\'app)', async () => {
    const env = await setupMerchant(srv, { balance: 0 });
    const newFormat = 'Depot recu: 7500 F de 70123456. Solde 7500 F. TxRef XX99887766';
    await env.merchant.createPaymentIntent({ reference: 'TPL-1', amount: 7500, payer_phone: '70123456' });

    const before = await sendSms(env.device, 'OrangeMoney', newFormat);
    assert.equal(before.status, 'ignored');

    const put = await admin(srv.baseUrl, 'PUT', '/admin/parsers/orange_bf_credit_v2', {
      operator: 'orange',
      kind: 'credit',
      senders: ['OrangeMoney'],
      priority: 20,
      pattern: String.raw`recu:\s*(?<amount>[\d\s]+?)\s*F\s+de\s+(?<payer>\d{8,11})\.\s*Solde\s+(?<balance>[\d\s]+?)\s*F\.\s*TxRef\s+(?<txn_id>[A-Z0-9]{6,})`,
      example: newFormat,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const after = await sendSms(env.device, 'OrangeMoney', newFormat.replace('XX99887766', 'XX99887767'));
    assert.equal(after.status, 'matched');
    await env.hooks.close();
  });
});
