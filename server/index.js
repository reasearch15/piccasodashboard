'use strict';
const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const { server, accounts, telegram, close } = createApp(config);

if (!accounts.db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  console.warn('No admin account exists yet. Run `npm run init-admin` before logging in.');
}

server.listen(config.port, config.host, () => {
  const { address, port } = server.address();
  console.log(`Picasso Dashboard (DEMO ledger) listening on http://${address}:${port}`);
  console.log(telegram ? `Telegram bridge: ${config.telegram.mode} via ${config.telegram.apiBase}` : 'Telegram bridge: off');
  telegram?.start().catch(e => {
    console.error(`Telegram bridge failed to start: ${e.message}`);
    process.exitCode = 1;
    close();
  });
});

const shutdown = () => close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
