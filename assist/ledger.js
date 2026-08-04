// The joined view: local work state (collect.js) + own PR state
// (assist/prs.js), joined by the same functions the browser panel uses
// (classify.js), classified by the same classify(). One document, no browser.
const { attachOwnPRs, synthesizeProcesses, classify } = require('../classify.js');
const { deriveFlags } = require('./flags.js');

const LEDGER_VERSION = 1;

// Pure: fold PRs into processes, add synthetic processes for orphan PRs, and
// attach a `state` per process. `extraWarnings` are collector-external (e.g.
// gh failures) merged with the payload's own.
function buildLedger(localPayload, prs, now, extraWarnings) {
  const { rows, unmatched } = attachOwnPRs(localPayload.processes, prs || []);
  const synthetic = synthesizeProcesses(unmatched);
  const allRows = rows.concat(synthetic);

  const processes = allRows.map(({ proc, prs }) => {
    const state = classify(proc, prs, now);
    return Object.assign({}, proc, { prs, state, flags: deriveFlags(proc, prs, state) });
  });

  return {
    version: LEDGER_VERSION,
    generatedAt: now,
    workspaceRoot: localPayload.workspaceRoot,
    processes,
    looseSessions: localPayload.looseSessions || [],
    warnings: (localPayload.warnings || []).concat(extraWarnings || []),
  };
}

// IO wrapper: run the collector and the PR fetch, then join. Everything is
// injected so tests never touch disk or the network.
async function ledger(opts) {
  const { collect, fetchOwnPRs, ioForCollect, now } = opts;
  const local = await collect(ioForCollect);
  const { prs, warnings } = await fetchOwnPRs(opts);
  return buildLedger(local, prs, now(), warnings);
}

module.exports = { buildLedger, ledger, LEDGER_VERSION };
