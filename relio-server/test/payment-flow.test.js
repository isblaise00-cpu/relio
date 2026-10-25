'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer, setupMerchant, sendSms, verifyWebhook } = require('./helpers');
const samples = require('../examples/sms-samples');

const PAYER = '70123456';

describe('Parcours de paiement', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('cas nominal : SMS authentique + intention correspondante => payé, webhook signé', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-1001', amount: 10000, payer_phone: PAYER });
    assert.equal(intent.status, 'pending');
    assert.equal(intent.pay_to.length, 1);
    assert.match(intent.pay_to[0].message, /10 000 FCFA/);

    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }));
    assert.equal(res.status, 'matched');
    assert.equal(res.intent_id, intent.id);
    // Le téléphone reçoit de quoi afficher « Payé · CMD-1001 · 10 000 FCFA ».
    assert.equal(res.intent_reference, 'CMD-1001');
    assert.equal(res.parsed.amount, 10000);
    assert.equal(res.parsed.operator, 'orange');
    assert.equal(res.source, 'live');

    const after = await env.merchant.getPaymentIntent(intent.id);
    assert.equal(after.status, 'succeeded');
    assert.equal(after.confirmation, 'auto');

    const wallets = await env.merchant.listWallets();
    assert.equal(wallets.data[0].balance, 35000);

    await srv.workers.runOnce();
    const hooks = env.hooks.ofType('payment_intent.succeeded');
    assert.equal(hooks.length, 1);
    const event = verifyWebhook(env.webhookSecret, hooks[0].raw, hooks[0].headers);
    assert.equal(event.data.id, intent.id);
    assert.equal(event.data.reference, 'CMD-1001');
    assert.equal(event.data.payment.amount, 10000);
    await env.hooks.close();
  });

  test('faux SMS (solde incohérent) correspondant à une intention => mis en attente puis suspicion de fraude', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-2001', amount: 10000, payer_phone: PAYER });

    // Le fraudeur connaît son numéro et le montant, mais pas le solde du marchand.
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 60000, txn: samples.txnId() }));
    assert.equal(res.status, 'held');
    assert.equal((await env.merchant.getPaymentIntent(intent.id)).status, 'pending');

    // Après HOLD_SECONDS, passage en vérification manuelle.
    await srv.workers.runOnce(Date.now() + (srv.ctx.cfg.holdSeconds + 1) * 1000);
    const reviews = await env.merchant.listReviews();
    assert.equal(reviews.data.length, 1);
    assert.equal(reviews.data[0].reason, 'suspected_fraud_balance');
    assert.equal(reviews.data[0].candidate_intent_id, intent.id);
    assert.equal((await env.merchant.getPaymentIntent(intent.id)).status, 'pending');
    assert.equal(env.hooks.ofType('payment_intent.succeeded').length, 0);

    // Le marchand confirme que c'est une fraude.
    const resolved = await env.merchant.resolveReview(reviews.data[0].id, { action: 'fraud', note: 'Absent de mon historique Orange Money' });
    assert.equal(resolved.resolution, 'fraud');
    assert.equal(resolved.sms.status, 'rejected');
    await env.hooks.close();
  });

  test('ID de transaction déjà vu => suspicion de fraude si correspondance, rejet sinon', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const txn = samples.txnId();
    await env.merchant.createPaymentIntent({ reference: 'CMD-3001', amount: 10000, payer_phone: PAYER });
    const first = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn }));
    assert.equal(first.status, 'matched');

    // Même ID, nouvelle intention identique : rejouer le SMS ne doit pas payer une 2e commande.
    const second = await env.merchant.createPaymentIntent({ reference: 'CMD-3002', amount: 10000, payer_phone: PAYER });
    const replay = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 45000, txn }));
    assert.equal(replay.status, 'review');
    assert.deepEqual(replay.reasons, ['suspected_fraud_duplicate']);
    assert.equal((await env.merchant.getPaymentIntent(second.id)).status, 'pending');

    // Même ID sans aucune intention correspondante : rejeté.
    const orphan = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 777, payer: '76000000', balance: 45777, txn }));
    assert.equal(orphan.status, 'rejected');
    assert.deepEqual(orphan.reasons, ['duplicate_transaction']);
    await env.hooks.close();
  });

  test('paiement authentique sans intention => vérification, puis rattachement manuel', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-4001', amount: 10000, payer_phone: PAYER });

    // Le client a payé depuis le téléphone de sa sœur.
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: '78999999', balance: 35000, txn: samples.txnId() }));
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['unknown_payer']);

    // Le solde a quand même avancé (SMS authentique).
    assert.equal((await env.merchant.listWallets()).data[0].balance, 35000);

    const [review] = (await env.merchant.listReviews()).data;
    const resolved = await env.merchant.resolveReview(review.id, { action: 'attach', intent_id: intent.id });
    assert.equal(resolved.resolution, 'attached');

    const paid = await env.merchant.getPaymentIntent(intent.id);
    assert.equal(paid.status, 'succeeded');
    assert.equal(paid.confirmation, 'manual');
    await env.hooks.close();
  });

  test('mauvais montant => vérification avec l\'intention la plus proche', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-5001', amount: 10000, payer_phone: PAYER });
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 9000, payer: PAYER, balance: 34000, txn: samples.txnId() }));
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['amount_mismatch']);
    const [review] = (await env.merchant.listReviews()).data;
    assert.equal(review.candidate_intent_id, intent.id);
    assert.match(review.reason_label, /montant/);
    await env.hooks.close();
  });

  test('SMS arrivés dans le désordre => la chaîne de soldes se répare toute seule', async () => {
    const env = await setupMerchant(srv, { balance: 100000 });
    const a = await env.merchant.createPaymentIntent({ reference: 'CMD-6001', amount: 10000, payer_phone: '70111111' });
    const b = await env.merchant.createPaymentIntent({ reference: 'CMD-6002', amount: 20000, payer_phone: '70222222' });

    // Réels : A (100 000 -> 110 000) puis B (110 000 -> 130 000). B arrive en premier.
    const rb = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 20000, payer: '70222222', balance: 130000, txn: samples.txnId() }));
    assert.equal(rb.status, 'held');

    const ra = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: '70111111', balance: 110000, txn: samples.txnId() }));
    assert.equal(ra.status, 'matched');

    assert.equal((await env.merchant.getPaymentIntent(a.id)).status, 'succeeded');
    assert.equal((await env.merchant.getPaymentIntent(b.id)).status, 'succeeded');
    assert.equal((await env.merchant.listWallets()).data[0].balance, 130000);
    assert.equal((await env.merchant.listReviews()).data.length, 0);
    await env.hooks.close();
  });

  test('renvoi du même SMS par le téléphone => traité une seule fois', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    await env.merchant.createPaymentIntent({ reference: 'CMD-7001', amount: 10000, payer_phone: PAYER });
    const id = crypto.randomUUID();
    const body = samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() });
    const first = await sendSms(env.device, 'OrangeMoney', body, { id });
    const again = await sendSms(env.device, 'OrangeMoney', body, { id });
    assert.equal(first.status, 'matched');
    assert.equal(again.status, 'matched');
    assert.equal(again.duplicate, true);
    assert.equal((await env.merchant.listMessages()).data.length, 1);
    await env.hooks.close();
  });

  test('deux intentions identiques en attente => refusé, puis idempotence par référence', async () => {
    const env = await setupMerchant(srv);
    const first = await env.merchant.createPaymentIntent({ reference: 'CMD-8001', amount: 5000, payer_phone: PAYER });
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'CMD-8002', amount: 5000, payer_phone: PAYER }), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'duplicate_pending_intent');
      assert.equal(err.body.error.existing_intent_id, first.id);
      return true;
    });
    // Même référence et mêmes paramètres : on récupère l'intention existante.
    const same = await env.merchant.createPaymentIntent({ reference: 'CMD-8001', amount: 5000, payer_phone: PAYER });
    assert.equal(same.id, first.id);
    // Même référence, autre montant : conflit.
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'CMD-8001', amount: 6000, payer_phone: PAYER }), { code: 'reference_conflict' });
    // Un montant légèrement différent est accepté.
    const other = await env.merchant.createPaymentIntent({ reference: 'CMD-8003', amount: 5005, payer_phone: PAYER });
    assert.equal(other.status, 'pending');
    await env.hooks.close();
  });

  test('intention expirée puis paiement tardif => vérification "late_payment" et rattachement possible', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-9001', amount: 10000, payer_phone: PAYER, expires_in: 60 });
    await srv.workers.runOnce(Date.now() + 61 * 1000);
    assert.equal((await env.merchant.getPaymentIntent(intent.id)).status, 'expired');
    assert.equal(env.hooks.ofType('payment_intent.expired').length, 1);

    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }));
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['late_payment']);

    const [review] = (await env.merchant.listReviews()).data;
    await env.merchant.resolveReview(review.id, { action: 'attach' }); // intention candidate utilisée par défaut
    assert.equal((await env.merchant.getPaymentIntent(intent.id)).status, 'succeeded');
    await env.hooks.close();
  });

  test('SMS antérieur à la création de l\'intention => pas de paiement automatique', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    await env.merchant.createPaymentIntent({ reference: 'CMD-9101', amount: 10000, payer_phone: PAYER });
    const oneHourAgo = Date.now() - 3600 * 1000;
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }), {
      received_at: oneHourAgo,
    });
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['sms_predates_intent']);
    await env.hooks.close();
  });

  test('débit : met à jour le solde ; débit non reconnu => désynchronisation puis resynchronisation', async () => {
    const env = await setupMerchant(srv, { balance: 50000 });

    const d1 = await sendSms(env.device, 'OrangeMoney', samples.orangeDebit({ amount: 5000, fee: 100, balance: 44900, txn: samples.txnId('CO') }));
    assert.equal(d1.status, 'recorded');
    assert.equal((await env.merchant.listWallets()).data[0].balance, 44900);

    // Débit dont le solde ne s'enchaîne pas (ex. un retrait dont le SMS a été perdu avant).
    const d2 = await sendSms(env.device, 'OrangeMoney', samples.orangeDebit({ amount: 1000, fee: 0, balance: 30000, txn: samples.txnId('CO') }));
    assert.deepEqual(d2.reasons, ['balance_mismatch']);
    const [wallet] = (await env.merchant.listWallets()).data;
    assert.equal(wallet.sync_status, 'unsynced');
    await srv.workers.runOnce();
    assert.equal(env.hooks.ofType('wallet.desynchronized').length, 1);

    // Tant que le portefeuille est désynchronisé, les paiements vont en vérification.
    await env.merchant.createPaymentIntent({ reference: 'CMD-9201', amount: 10000, payer_phone: PAYER });
    const c = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 40000, txn: samples.txnId() }));
    assert.deepEqual(c.reasons, ['balance_unverified']);

    // Le marchand indique son solde réel : le contrôle automatique reprend.
    const resynced = await env.merchant.resyncWallet(wallet.id, 40000);
    assert.equal(resynced.sync_status, 'synced');
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-9202', amount: 3000, payer_phone: PAYER });
    const ok = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 3000, payer: PAYER, balance: 43000, txn: samples.txnId() }));
    assert.equal(ok.status, 'matched');
    assert.equal(ok.intent_id, intent.id);
    await env.hooks.close();
  });

  test('portefeuille sans solde initial => vérification ; rattacher fixe le solde de référence', async () => {
    const env = await setupMerchant(srv, { balance: null });
    const i1 = await env.merchant.createPaymentIntent({ reference: 'CMD-9301', amount: 10000, payer_phone: PAYER });
    const r1 = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }));
    assert.deepEqual(r1.reasons, ['balance_unverified']);
    const [review] = (await env.merchant.listReviews()).data;
    await env.merchant.resolveReview(review.id, { action: 'attach', intent_id: i1.id });
    const [wallet] = (await env.merchant.listWallets()).data;
    assert.equal(wallet.sync_status, 'synced');
    assert.equal(wallet.balance, 35000);

    // Le paiement suivant est confirmé automatiquement.
    await env.merchant.createPaymentIntent({ reference: 'CMD-9302', amount: 2000, payer_phone: PAYER });
    const r2 = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 2000, payer: PAYER, balance: 37000, txn: samples.txnId() }));
    assert.equal(r2.status, 'matched');
    await env.hooks.close();
  });

  test('SMS d\'un expéditeur non autorisé => rejeté ; message promo => ignoré', async () => {
    const env = await setupMerchant(srv);
    await env.merchant.createPaymentIntent({ reference: 'CMD-9401', amount: 10000, payer_phone: PAYER });
    const spoof = await sendSms(env.device, '+22670999999', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }));
    assert.equal(spoof.status, 'rejected');
    const promo = await sendSms(env.device, 'OrangeMoney', 'Profitez de 50% de bonus sur vos recharges !');
    assert.equal(promo.status, 'ignored');
    await env.hooks.close();
  });

  test('intention avec opérateur imposé : paiement reçu sur l\'autre opérateur => vérification', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    await env.merchant.createWallet({ operator: 'moov', phone: '60000001', balance: 10000 });
    await env.merchant.createPaymentIntent({ reference: 'CMD-9501', amount: 4000, payer_phone: PAYER, operator: 'orange' });
    const res = await sendSms(env.device, 'MoovMoney', samples.moovCredit({ amount: 4000, payer: PAYER, balance: 14000, txn: samples.txnId('MV') }));
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['operator_mismatch']);
    await env.hooks.close();
  });

  test('mode test : SMS analysé mais jamais rapproché, sans effet sur le solde ni les doublons', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-9701', amount: 5000, payer_phone: PAYER });
    const txn = samples.txnId();
    const body = samples.orangeCredit({ amount: 5000, payer: PAYER, balance: 30000, txn });

    const t = await sendSms(env.device, 'OrangeMoney', body, { source: 'test' });
    assert.equal(t.status, 'test');
    assert.equal(t.parsed.amount, 5000);
    assert.equal(t.intent_id, null);
    assert.equal((await env.merchant.getPaymentIntent(intent.id)).status, 'pending');
    assert.equal((await env.merchant.listWallets()).data[0].balance, 25000);
    assert.equal((await env.merchant.listReviews()).data.length, 0);

    // Le même ID de transaction, reçu ensuite pour de vrai, n'est pas pris pour un doublon.
    const real = await sendSms(env.device, 'OrangeMoney', body);
    assert.equal(real.status, 'matched');
    assert.equal(real.intent_reference, 'CMD-9701');

    await assert.rejects(sendSms(env.device, 'OrangeMoney', body, { source: 'autre' }), { code: 'invalid_message' });
    await env.hooks.close();
  });

  test('vérification manuelle : la réponse indique la commande candidate', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    await env.merchant.createPaymentIntent({ reference: 'CMD-9801', amount: 10000, payer_phone: PAYER });
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 9500, payer: PAYER, balance: 34500, txn: samples.txnId() }));
    assert.equal(res.status, 'review');
    assert.equal(res.intent_reference, null);
    assert.equal(res.candidate_intent_reference, 'CMD-9801');
    await env.hooks.close();
  });

  test('annulation d\'une intention => plus de paiement automatique', async () => {
    const env = await setupMerchant(srv, { balance: 25000 });
    const intent = await env.merchant.createPaymentIntent({ reference: 'CMD-9601', amount: 10000, payer_phone: PAYER });
    const canceled = await env.merchant.cancelPaymentIntent(intent.id);
    assert.equal(canceled.status, 'canceled');
    const res = await sendSms(env.device, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: PAYER, balance: 35000, txn: samples.txnId() }));
    assert.equal(res.status, 'review');
    assert.deepEqual(res.reasons, ['unknown_payer']);
    await assert.rejects(env.merchant.cancelPaymentIntent(intent.id), { code: 'intent_not_cancelable' });
    await env.hooks.close();
  });
});
