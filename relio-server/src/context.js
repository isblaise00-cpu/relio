'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createVault } = require('./lib/vault');
const parser = require('./services/parser');

function createLogger(quiet) {
  const stamp = () => new Date().toISOString();
  return {
    info: (...a) => { if (!quiet) console.log(stamp(), '[info]', ...a); },
    warn: (...a) => { if (!quiet) console.warn(stamp(), '[warn]', ...a); },
    error: (...a) => console.error(stamp(), '[error]', ...a),
  };
}

/**
 * Contexte partagé par toute l'application : configuration, base, logger, coffre-fort.
 */
function createContext(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDatabase(cfg.dbPath);
  const ctx = {
    cfg,
    db,
    log: createLogger(cfg.quiet),
    vault: createVault(cfg.masterKeyBuf),
    cache: {},
  };
  parser.seedDefaultTemplates(ctx);
  return ctx;
}

module.exports = { createContext };
