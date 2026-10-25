'use strict';

const { createContext } = require('./context');
const { createApp } = require('./app');
const { createWorkers } = require('./workers');

function main() {
  const ctx = createContext();
  const app = createApp(ctx);
  const workers = createWorkers(ctx);

  const server = app.listen(ctx.cfg.port, (err) => {
    if (err) {
      ctx.log.error('Impossible de démarrer le serveur :', err);
      process.exit(1);
    }
    ctx.log.info(`SmsPay MVP à l'écoute sur http://localhost:${ctx.cfg.port} (base : ${ctx.cfg.dbPath})`);
    if (!ctx.cfg.adminToken) ctx.log.warn('ADMIN_TOKEN vide : les routes /admin sont désactivées.');
  });
  workers.start();

  const shutdown = (signal) => {
    ctx.log.info(`${signal} reçu, arrêt en cours…`);
    workers.stop();
    server.close(() => {
      ctx.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
