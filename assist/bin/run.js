#!/usr/bin/env node
// Real-IO/real-exec entry for the executor. Builds a fresh ledger→gate (reusing
// the same wiring as assist/bin/queue.js and assist/bin/gate.js) and runs the
// executor CLI. Process execution goes through spawnSync — NEVER a shell — so a
// branch name carrying shell metacharacters cannot inject. state/ is gitignored.
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate } = require('../gate.js');
const { babysitStateDir } = require('./gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');
const { queuePaths } = require('../queue.js');
const { fsIo, stateRoot } = require('./queue.js');
const { runCli } = require('../executor.js');

// The one place a child process is spawned. execFile-style: argv[0] is the
// program, the rest are literal args — no shell, no interpolation. Never throws
// on a non-zero exit; the code is a value the caller inspects.
function exec(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  return { code: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  const checkoutDir = path.resolve(__dirname, '..', '..');
  const loadGate = async () => {
    const doc = await ledger({
      collect, fetchOwnPRs,
      ioForCollect: { env: process.env, homeDir: os.homedir(), checkoutDir, run, listDirs, listFiles, readTail, now: () => Date.now() },
      run, now: () => Date.now(),
    });
    const gate = buildGate(doc, Date.now(), {
      babysitDir: babysitStateDir(process.env, os.homedir()),
      io: { exists: fsIo.exists, readText: fsIo.read, listFiles: (d) => fsIo.list(d) },
    });
    return { gate, warnings: doc.warnings || [] };
  };

  const paths = queuePaths(stateRoot(checkoutDir));
  [paths.items, paths.answers, paths.done, paths.declined, paths.tmp].forEach(fsIo.mkdirp);

  const res = await runCli(process.argv.slice(2), { io: fsIo, exec, paths, loadGate, now: () => Date.now() });
  process.stdout.write(JSON.stringify(res.output, null, 2) + '\n');
  return res.exit;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(3); });
}

module.exports = { main, exec };
