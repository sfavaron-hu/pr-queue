#!/usr/bin/env node
// Real-IO wrapper around buildGate(). Runs the ledger, builds the gate, prints
// it as JSON, and exits with the heartbeat's code. Reuses bin/collect.js's IO
// helpers and assist/ledger.js — no path or fetch logic is duplicated. The
// pr-babysit state dir is read read-only through node:fs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate, gateExitCode } = require('../gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');

// pr-babysit keeps its state under the Claude config dir, same convention the
// collector uses for CLAUDE_CONFIG_DIR. Derived, never hardcoded.
function babysitStateDir(env, homeDir) {
  const base = (env && env.CLAUDE_CONFIG_DIR) || path.join(homeDir, '.claude');
  return path.join(base, 'skills', 'pr-babysit', 'state');
}

const fsIo = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => fs.readFileSync(p, 'utf8'),
  listFiles: (d) => fs.readdirSync(d),
};

async function main() {
  let doc;
  try {
    doc = await ledger({
      collect,
      fetchOwnPRs,
      ioForCollect: {
        env: process.env, homeDir: os.homedir(),
        checkoutDir: path.resolve(__dirname, '..', '..'),
        run, listDirs, listFiles, readTail, now: () => Date.now(),
      },
      run,
      now: () => Date.now(),
    });
  } catch (err) {
    // Could not build the ledger at all — exit 3 (not 0), so a caller never
    // reads "nothing to do" from a pass that checked nothing.
    console.error(err);
    return 3;
  }

  const gate = buildGate(doc, Date.now(), {
    babysitDir: babysitStateDir(process.env, os.homedir()),
    io: fsIo,
  });
  process.stdout.write(JSON.stringify(gate, null, 2) + '\n');
  return gateExitCode(gate, doc.warnings || []);
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main, babysitStateDir };
