#!/usr/bin/env node
// Real-IO wrapper around ledger(). Prints the joined document to stdout.
// Reuses bin/collect.js's IO helpers — no path or process logic is duplicated.
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');

async function main() {
  const doc = await ledger({
    collect,
    fetchOwnPRs,
    ioForCollect: {
      env: process.env,
      homeDir: os.homedir(),
      checkoutDir: path.resolve(__dirname, '..', '..'),
      run, listDirs, listFiles, readTail,
      now: () => Date.now(),
    },
    run,
    now: () => Date.now(),
  });
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main };
