'use strict';

/**
 * TESTER L'API DE PAIEMENT
 *
 * Prérequis :
 *   1. Serveur lancé :  npm run dev
 *   2. Renseigner les variables ci-dessous avec les credentials du marchand
 *      (récupérables dans le dashboard → clic sur le marchand → "Voir les secrets")
 *
 * Lancer :
 *   node examples/test-payment.js
 */

const { SmsPayClient } = require('../clients/node/smspay-client');

// ─── À REMPLIR ────────────────────────────────────────────────────────────────

const BASE_URL   = 'http://localhost:3000';
const API_KEY    = 'mk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';         // api_key du marchand
const API_SECRET = 'sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // api_secret du marchand

// Numéro Mobile Money sur lequel le marchand REÇOIT l'argent
// (la SIM dans le téléphone Android appairé)
const WALLET_OPERATOR = 'orange';     // label de l'opérateur (défini dans les templates)
const WALLET_PHONE    = '226XXXXXXXXX';  // numéro complet avec indicatif
const WALLET_BALANCE  = 0;               // solde actuel réel de ce numéro (FCFA)

// ─────────────────────────────────────────────────────────────────────────────

const client = new SmsPayClient({ baseUrl: BASE_URL, apiKey: API_KEY, apiSecret: API_SECRET });

async function main() {
  console.log('=== Test API Relio ===\n');

  // 1. Vérifier la connexion
  console.log('1. Connexion...');
  const merchant = await client.getMerchant();
  console.log(`   ✓ Marchand : ${merchant.name} (${merchant.id})\n`);

  // 2. Créer ou récupérer le portefeuille (idempotent)
  console.log('2. Portefeuille Mobile Money...');
  let wallets = await client.listWallets();
  if (wallets.data.length === 0) {
    const wallet = await client.createWallet({
      operator: WALLET_OPERATOR,
      phone: WALLET_PHONE,
      balance: WALLET_BALANCE,
    });
    console.log(`   ✓ Créé : ${wallet.phone} — solde ${wallet.balance} FCFA`);
  } else {
    console.log(`   ✓ Existant : ${wallets.data.map(w => `${w.phone} (${w.balance} FCFA)`).join(', ')}`);
  }
  console.log();

  // 3. Créer une intention de paiement
  const reference = `ORDER-${Date.now()}`;
  console.log(`3. Création d'une intention de paiement...`);
  const intent = await client.createPaymentIntent({
    reference,                    // identifiant unique côté votre système (numéro de commande, etc.)
    amount: 1,                 // montant EXACT attendu en FCFA (entier)
    payer_phone: '22666459432',   // numéro Mobile Money du client qui va payer
    // operator: 'moov_money',    // optionnel : forcer un opérateur spécifique
    // expires_in: 900,           // optionnel : durée de validité en secondes (défaut 900 = 15 min)
    // metadata: { order_id: 42, customer: 'Aminata' },  // optionnel : données libres
  });

  console.log(`   ✓ Intention créée :`);
  console.log(`     ID        : ${intent.id}`);
  console.log(`     Référence : ${intent.reference}`);
  console.log(`     Montant   : ${intent.amount} FCFA`);
  console.log(`     Payeur    : ${intent.payer_phone}`);
  console.log(`     Statut    : ${intent.status}`);
  console.log(`     Expire le : ${intent.expires_at}`);
  if (intent.pay_to?.length) {
    console.log(`\n   Instructions pour le client :`);
    intent.pay_to.forEach(p => console.log(`     → ${p.message}`));
  }
  console.log();

  // 4. Retrouver l'intention par référence (comme votre backend le ferait)
  console.log(`4. Vérification du statut par référence...`);
  const found = await client.findPaymentIntent(reference);
  console.log(`   ✓ Statut actuel : ${found.status}\n`);

  // 5. Idempotence : même référence => même intention
  console.log(`5. Test d'idempotence (même référence, même montant)...`);
  const same = await client.createPaymentIntent({
    reference,
    amount: 5000,
    payer_phone: '22670574131',
  });
  console.log(`   ✓ Même ID retourné : ${same.id === intent.id} (${same.id})\n`);

  // 6. Annuler l'intention
  console.log(`6. Annulation...`);
  const canceled = await client.cancelPaymentIntent(intent.id);
  console.log(`   ✓ Statut : ${canceled.status}\n`);

  console.log('=== Terminé ===');
  console.log('\nProchaine étape : laisser le client payer via Mobile Money et');
  console.log('observer le statut passer à "succeeded" via webhook ou polling.');
}

main().catch(e => {
  console.error('\n✗ Erreur :', e.message);
  if (e.body) console.error('  Détail :', JSON.stringify(e.body, null, 2));
  process.exit(1);
});
