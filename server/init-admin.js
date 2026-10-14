'use strict';
// One-time admin initialisation.
//
//   npm run init-admin                     prompts for the password (hidden input)
//   PICASSO_ADMIN_PASSWORD=... npm run init-admin
//   npm run init-admin -- --reset-password  replaces an existing admin password
//
// The password is never written to disk, logged, or echoed. Only its Argon2id
// hash is stored in data/auth.db.
const { loadConfig } = require('./config');
const { openAuthDb } = require('./db');
const { Accounts, initAdmin } = require('./accounts');
const { validatePassword } = require('./passwords');

function promptHidden(question) {
  return new Promise(resolve => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const config = loadConfig();
  const resetPassword = process.argv.includes('--reset-password');
  let password = process.env.PICASSO_ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) {
      throw new Error('Set PICASSO_ADMIN_PASSWORD or run this command in an interactive terminal to be prompted.');
    }
    password = await promptHidden(`New password for admin "${config.adminUsername}": `);
    const problem = validatePassword(password);
    if (problem) throw new Error(problem);
    if ((await promptHidden('Confirm password: ')) !== password) throw new Error('Passwords do not match.');
  }
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);

  const accounts = new Accounts(openAuthDb(config.dataDir), config);
  const { user, created } = await initAdmin(accounts, config.adminUsername, password, { resetPassword });
  console.log(created
    ? `Admin "${user.username}" created.`
    : `Password for admin "${user.username}" replaced; all of its sessions were signed out.`);
  if (process.env.PICASSO_ADMIN_PASSWORD) {
    console.log('Remove PICASSO_ADMIN_PASSWORD from your environment / .env now; it is only needed for this command.');
  }
}

main().catch(e => {
  console.error(`init-admin failed: ${e.message}`);
  process.exit(1);
});
