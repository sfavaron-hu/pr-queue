#!/usr/bin/env node
// Real-fs wrapper around the queue. Runs the live gate, syncs its items into
// state/assist/, prunes expired declines and old done records, and prints the
// open queue. Reuses assist/bin/gate.js's ledger+gate wiring and bin/collect's
// IO helpers — no path or fetch logic is duplicated. state/ is gitignored.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs, fetchPRsForBranches } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate } = require('../gate.js');
const { babysitStateDir } = require('./gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');
const {
  queuePaths, syncItems, pruneDeclined, pruneDone, listOpenItems,
} = require('../queue.js');

// The queue lives beside the checkout, under a gitignored state/ dir. Derived
// from the checkout path, never hardcoded.
function stateRoot(checkoutDir) { return path.join(checkoutDir, 'state'); }

// The injected-io shape backed by the real filesystem. Directory reads tolerate
// a not-yet-created dir (empty list); everything else is a thin fs pass-through.
const fsIo = {
  now: () => Date.now(),
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, s) => fs.writeFileSync(p, s),
  rename: (a, b) => fs.renameSync(a, b),
  remove: (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } },
  exists: (p) => fs.existsSync(p),
  list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
};

async function main() {
  const checkoutDir = path.resolve(__dirname, '..', '..');
  const doc = await ledger({
    collect, fetchOwnPRs, fetchPRsForBranches,
    ioForCollect: {
      env: process.env, homeDir: os.homedir(), checkoutDir,
      run, listDirs, listFiles, readTail, now: () => Date.now(),
    },
    run, now: () => Date.now(),
  });
  const gate = buildGate(doc, Date.now(), {
    babysitDir: babysitStateDir(process.env, os.homedir()), io: {
      exists: fsIo.exists, readText: fsIo.read, listFiles: (d) => fsIo.list(d),
    },
  });

  const paths = queuePaths(stateRoot(checkoutDir));
  // Ensure the four dirs exist before syncing.
  [paths.items, paths.answers, paths.done, paths.declined, paths.tmp].forEach(fsIo.mkdirp);

  const res = syncItems(fsIo, paths, gate.questions);   // notify items are not queued decisions
  const declinedPruned = pruneDeclined(fsIo, paths);
  const donePruned = pruneDone(fsIo, paths, 30);
  const open = listOpenItems(fsIo, paths);

  process.stdout.write(JSON.stringify({
    written: res.written.length, skipped: res.skipped.length, removed: res.removed.length,
    declinedPruned, donePruned,
    open: open.map(o => ({ id: o.id, key: o.item.key, answered: o.answer !== null })),
  }, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main, fsIo, stateRoot };
