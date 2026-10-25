'use strict';

/*
 * CŒUR DU SYSTÈME : traitement des SMS transmis par le téléphone du marchand.
 *
 * Pour chaque SMS de crédit (argent reçu), deux questions :
 *
 *  1. Le SMS est-il AUTHENTIQUE ?
 *     - expéditeur connu (OrangeMoney, MoovMoney…)            -> sinon rejeté
 *     - format reconnu par un modèle                            -> sinon ignoré
 *     - ID de transaction jamais vu                             -> sinon "échec dur"
 *     - continuité du solde : ancien solde + montant = nouveau  -> sinon "échec souple"
 *
 *  2. CORRESPOND-il à une intention de paiement ?
 *     même payeur + même montant + intention en attente, non expirée,
 *     créée avant la réception du SMS.
 *
 *  Décision :
 *   authentique  + correspond      -> intention payée automatiquement (webhook)
 *   authentique  + ne correspond   -> vérification manuelle (paiement réel non rattaché)
 *   solde faux   + correspond      -> mis en attente HOLD_SECONDS, puis vérification (suspicion de fraude)
 *   solde faux   + ne correspond   -> mis en attente, puis vérification
 *   doublon      + correspond      -> vérification (suspicion de fraude)
 *   doublon      + ne correspond   -> rejeté et journalisé
 *
 * La mise en attente permet de gérer les SMS arrivés dans le désordre : dès qu'un
 * SMS authentique fait avancer le solde, les SMS en attente qui "s'enchaînent"
 * correctement sont retraités automatiquement.
 */

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { normalizePhone, parseTimestamp, displayPhone, iso } = require('../lib/format');
const { transaction } = require('../db');
const parser = require('./parser');
const wallets = require('./wallets');
const intents = require('./intents');
const reviews = require('./reviews');
const events = require('./events');

const MAX_BATCH = 50;

/**
 * Origine d'un SMS :
 *  - live       : reçu en temps réel
 *  - inbox_scan : récupéré en relisant la boîte de réception (après une panne)
 *  - test       : envoyé depuis le mode test de l'appli ; analysé mais JAMAIS rapproché
 *                 d'un paiement, et sans effet sur le solde de référence.
 */
const SOURCES = ['live', 'inbox_scan', 'test'];

function validateMessage(raw, idx, ctx) {
  const bad = (msg) => {
    throw new ApiError(400, 'invalid_message', `messages[${idx}] : ${msg}`);
  };
  if (!raw || typeof raw !== 'object') bad('objet attendu');
  if (typeof raw.id !== 'string' || !raw.id.length || raw.id.length > 128) bad('id obligatoire (identifiant unique du SMS côté téléphone)');
  if (typeof raw.sender !== 'string' || !raw.sender.length || raw.sender.length > 64) bad('sender obligatoire');
  if (typeof raw.body !== 'string' || !raw.body.length || raw.body.length > 2000) bad('body obligatoire (2000 caractères max)');
  const receivedAt = parseTimestamp(raw.received_at);
  if (raw.received_at !== undefined && receivedAt === null) bad('received_at invalide');
  const simSlot = raw.sim_slot === undefined || raw.sim_slot === null ? null : raw.sim_slot;
  if (simSlot !== null && !Number.isInteger(simSlot)) bad('sim_slot doit être un entier');
  const simMsisdn = raw.sim_phone ? normalizePhone(raw.sim_phone, ctx.cfg.defaultCountryCode) : null;
  const source = raw.source === undefined ? 'live' : raw.source;
  if (!SOURCES.includes(source)) bad(`source doit valoir ${SOURCES.join(', ')}`);
  return { id: raw.id, sender: raw.sender, body: raw.body, receivedAt, simSlot, simMsisdn, source };
}

function getSms(ctx, id) {
  return ctx.db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id);
}

function updateSms(ctx, id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE sms_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  ctx.db.prepare(sql).run(...keys.map((k) => (fields[k] === undefined ? null : fields[k])), id);
}

/**
 * Réponse renvoyée au téléphone pour chaque SMS. Elle contient de quoi afficher
 * le journal de l'appli : statut, motifs, numéro de commande, données extraites.
 */
function summarize(ctx, sms, duplicate = false) {
  const intentId = sms.intent_id || sms.candidate_intent_id;
  const intent = intentId ? ctx.db.prepare('SELECT reference FROM payment_intents WHERE id = ?').get(intentId) : null;
  return {
    id: sms.device_msg_id,
    sms_id: sms.id,
    source: sms.source,
    status: sms.status,
    reasons: sms.reasons ? JSON.parse(sms.reasons) : [],
    intent_id: sms.intent_id,
    intent_reference: sms.intent_id && intent ? intent.reference : null,
    candidate_intent_reference: !sms.intent_id && intent ? intent.reference : null,
    parsed: sms.kind
      ? {
          operator: sms.operator,
          kind: sms.kind,
          amount: sms.amount,
          fee: sms.fee,
          payer_phone: displayPhone(sms.payer_msisdn),
          payer_name: sms.payer_name || null,
          transaction_id: sms.transaction_id,
        }
      : null,
    duplicate,
  };
}

/** Point d'entrée : lot de SMS envoyé par un téléphone. */
function ingestBatch(ctx, device, messages, now = Date.now()) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_BATCH) {
    throw new ApiError(400, 'invalid_messages', `messages doit être une liste de 1 à ${MAX_BATCH} SMS`);
  }
  const valid = messages.map((m, i) => validateMessage(m, i, ctx));
  return valid.map((m) => transaction(ctx.db, () => ingestOne(ctx, device, m, now)));
}

function ingestOne(ctx, device, m, now) {
  // Idempotence : le téléphone peut renvoyer le même SMS (coupure réseau, nouvelle tentative).
  const existing = ctx.db.prepare('SELECT * FROM sms_messages WHERE device_id = ? AND device_msg_id = ?').get(device.id, m.id);
  if (existing) return summarize(ctx, existing, true);

  // Horloge du téléphone dans le futur : on la ramène à l'heure du serveur.
  let receivedAt = m.receivedAt ?? now;
  if (receivedAt > now + ctx.cfg.matchClockSkewS * 1000) receivedAt = now;

  const id = newId('sms');
  ctx.db
    .prepare(
      `INSERT INTO sms_messages (id, merchant_id, device_id, device_msg_id, sender, body, sim_slot, sim_msisdn,
         device_received_at, created_at, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    )
    .run(id, device.merchant_id, device.id, m.id, m.sender, m.body, m.simSlot, m.simMsisdn, receivedAt, now, m.source);

  classify(ctx, device, getSms(ctx, id), now);
  return summarize(ctx, getSms(ctx, id));
}

function classify(ctx, device, sms, now) {
  const parsed = parser.parseSms(ctx, sms.sender, sms.body);
  if (parsed.error === 'sender_not_allowed') {
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['sender_not_allowed']) });
  }
  if (parsed.error) {
    return updateSms(ctx, sms.id, { status: 'ignored', reasons: JSON.stringify([parsed.error]) });
  }

  // Mode test : on montre ce que le serveur a compris, sans aucun effet.
  if (sms.source === 'test') {
    return updateSms(ctx, sms.id, {
      template_id: parsed.templateId,
      operator: parsed.operator,
      kind: parsed.kind,
      amount: parsed.amount,
      fee: parsed.fee,
      payer_msisdn: parsed.payer,
      payer_name: parsed.payerName,
      new_balance: parsed.balance,
      transaction_id: parsed.txnId,
      status: 'test',
      reasons: '[]',
    });
  }

  const wallet = wallets.resolveForSms(ctx, device.merchant_id, parsed.operator, sms.sim_msisdn);
  updateSms(ctx, sms.id, {
    template_id: parsed.templateId,
    operator: parsed.operator,
    kind: parsed.kind,
    amount: parsed.amount,
    fee: parsed.fee,
    payer_msisdn: parsed.payer,
    payer_name: parsed.payerName,
    new_balance: parsed.balance,
    transaction_id: parsed.txnId,
    wallet_id: wallet ? wallet.id : null,
  });
  const fresh = getSms(ctx, sms.id);
  if (parsed.kind === 'debit') return handleDebit(ctx, fresh, wallet, now);
  return handleCredit(ctx, fresh, wallet, now);
}

/**
 * SMS de débit (retrait, transfert sortant…) : sert uniquement à maintenir le solde
 * de référence à jour. S'il ne s'enchaîne pas, le portefeuille est désynchronisé :
 * les crédits suivants iront en vérification jusqu'à une resynchronisation.
 */
function handleDebit(ctx, sms, wallet, now) {
  if (!wallet) {
    return updateSms(ctx, sms.id, { status: 'recorded', reasons: JSON.stringify(['wallet_not_found']) });
  }
  if (isDuplicateTxn(ctx, sms)) {
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['duplicate_transaction']) });
  }
  const expected = wallet.balance === null ? null : wallet.balance - sms.amount - (sms.fee || 0);
  if (wallet.sync_status === 'synced' && expected === sms.new_balance) {
    wallets.setBalance(ctx, wallet.id, sms.new_balance, now);
    updateSms(ctx, sms.id, { status: 'recorded', reasons: '[]' });
    return reprocessHeld(ctx, wallet.id, now);
  }
  if (wallet.sync_status === 'synced') {
    wallets.markUnsynced(ctx, wallet.id);
    events.enqueue(
      ctx,
      wallet.merchant_id,
      'wallet.desynchronized',
      {
        wallet: wallets.serializeWallet(wallets.getWallet(ctx, wallet.id)),
        expected_balance: expected,
        announced_balance: sms.new_balance,
        sms_id: sms.id,
      },
      now,
    );
  }
  return updateSms(ctx, sms.id, { status: 'recorded', reasons: JSON.stringify(['balance_mismatch']) });
}

function isDuplicateTxn(ctx, sms) {
  return !!ctx.db
    .prepare(`SELECT id FROM sms_messages WHERE operator = ? AND transaction_id = ? AND id <> ? AND source <> 'test' LIMIT 1`)
    .get(sms.operator, sms.transaction_id, sms.id);
}

function candidatesFor(ctx, sms, now) {
  return intents.findCandidates(
    ctx,
    {
      merchantId: sms.merchant_id,
      payer: sms.payer_msisdn,
      amount: sms.amount,
      operator: sms.operator,
      receivedAt: sms.device_received_at,
    },
    now,
  );
}

function toReview(ctx, sms, reason, candidateIntentId, now) {
  const reasons = sms.reasons ? JSON.parse(sms.reasons) : [];
  if (!reasons.includes(reason)) reasons.push(reason);
  updateSms(ctx, sms.id, { status: 'review', reasons: JSON.stringify(reasons), candidate_intent_id: candidateIntentId || null, hold_until: null });
  reviews.createReview(ctx, { merchantId: sms.merchant_id, smsId: sms.id, candidateIntentId, reason }, now);
}

function handleCredit(ctx, sms, wallet, now) {
  const cand = candidatesFor(ctx, sms, now);
  const candidateId = cand.exact ? cand.exact.id : cand.related ? cand.related.id : null;

  // Échec dur : ID de transaction déjà vu.
  if (isDuplicateTxn(ctx, sms)) {
    if (cand.exact) return toReview(ctx, sms, 'suspected_fraud_duplicate', cand.exact.id, now);
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['duplicate_transaction']) });
  }

  if (!wallet) return toReview(ctx, sms, 'wallet_not_found', candidateId, now);

  // Pas de solde de référence : authenticité invérifiable.
  if (wallet.sync_status !== 'synced' || wallet.balance === null) {
    return toReview(ctx, sms, 'balance_unverified', candidateId, now);
  }

  // Échec souple : le solde ne s'enchaîne pas. On met en attente.
  if (wallet.balance + sms.amount !== sms.new_balance) {
    updateSms(ctx, sms.id, {
      status: 'held',
      reasons: JSON.stringify(['balance_mismatch']),
      candidate_intent_id: cand.exact ? cand.exact.id : null,
      hold_until: now + ctx.cfg.holdSeconds * 1000,
    });
    return null;
  }

  settleAuthenticCredit(ctx, sms, wallet, now);
  return reprocessHeld(ctx, wallet.id, now);
}

/** SMS de crédit authentifié : met à jour le solde puis règle l'intention ou ouvre une vérification. */
function settleAuthenticCredit(ctx, sms, wallet, now) {
  wallets.setBalance(ctx, wallet.id, sms.new_balance, now);
  const cand = candidatesFor(ctx, sms, now);
  if (cand.exact) {
    intents.succeedIntent(ctx, cand.exact, sms, 'auto', now);
    updateSms(ctx, sms.id, { status: 'matched', intent_id: cand.exact.id, reasons: '[]', hold_until: null, candidate_intent_id: null });
    return;
  }
  updateSms(ctx, sms.id, { reasons: '[]' });
  toReview(ctx, getSms(ctx, sms.id), cand.reason, cand.related ? cand.related.id : null, now);
}

/**
 * Après chaque avancée du solde de référence, retraite les SMS en attente qui
 * s'enchaînent désormais correctement (SMS arrivés dans le désordre).
 */
function reprocessHeld(ctx, walletId, now = Date.now()) {
  for (let i = 0; i < 100; i++) {
    const wallet = wallets.getWallet(ctx, walletId);
    if (!wallet || wallet.sync_status !== 'synced' || wallet.balance === null) return;
    const next = ctx.db
      .prepare(
        `SELECT * FROM sms_messages WHERE wallet_id = ? AND status = 'held' AND amount + ? = new_balance
         ORDER BY device_received_at, created_at, rowid LIMIT 1`,
      )
      .get(walletId, wallet.balance);
    if (!next) return;
    settleAuthenticCredit(ctx, next, wallet, now);
  }
}

/** Tâche de fond : les SMS restés en attente trop longtemps passent en vérification manuelle. */
function promoteHeld(ctx, now = Date.now()) {
  const due = ctx.db.prepare(`SELECT * FROM sms_messages WHERE status = 'held' AND hold_until <= ? LIMIT 500`).all(now);
  for (const sms of due) {
    transaction(ctx.db, () => {
      const current = getSms(ctx, sms.id);
      if (current.status !== 'held') return;
      // On recalcule : l'intention a pu être payée, annulée ou expirer entre-temps.
      const cand = candidatesFor(ctx, current, now);
      if (cand.exact) {
        toReview(ctx, current, 'suspected_fraud_balance', cand.exact.id, now);
      } else {
        toReview(ctx, current, 'balance_mismatch', cand.related ? cand.related.id : null, now);
      }
    });
  }
  return due.length;
}

function serializeIncoming(sms) {
  return {
    id: sms.id,
    device_msg_id: sms.device_msg_id,
    sender: sms.sender,
    operator: sms.operator,
    kind: sms.kind,
    amount: sms.amount,
    payer_phone: displayPhone(sms.payer_msisdn),
    payer_name: sms.payer_name || null,
    new_balance: sms.new_balance,
    transaction_id: sms.transaction_id,
    status: sms.status,
    reasons: sms.reasons ? JSON.parse(sms.reasons) : [],
    intent_id: sms.intent_id,
    received_at: iso(sms.device_received_at),
    source: sms.source,
  };
}

function listMessages(ctx, merchantId, { limit = 50, status } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = status
    ? ctx.db
        .prepare('SELECT * FROM sms_messages WHERE merchant_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(merchantId, status, lim)
    : ctx.db.prepare('SELECT * FROM sms_messages WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(merchantId, lim);
  return rows.map(serializeIncoming);
}

module.exports = { ingestBatch, reprocessHeld, promoteHeld, listMessages, MAX_BATCH };
