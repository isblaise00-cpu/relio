'use strict';

const crypto = require('node:crypto');

/** Identifiant public lisible, ex. "pi_3f9a…". */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Secret long, ex. "sk_…". */
function newSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

/** Code d'appairage à 6 chiffres. */
function newPairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { newId, newSecret, newPairingCode };
