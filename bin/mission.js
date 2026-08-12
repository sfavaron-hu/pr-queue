// bin/mission.js
// Real IO for /api/mission: exec of the `mc` CLI, TTL and single-flight.
// Mirrors the collect.js / bin/collect.js split — the pure half lives in
// ../mission.js and is the only part the browser loads.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { classifyMissionRead } = require('../mission.js');

const DEFAULT_TTL_MS = 60000;
const EXEC_TIMEOUT_MS = 20000;

// bin/collect.js's `run` rejects on a non-zero exit, which is exactly wrong
// here: mc exits 10 when there are questions and 3 when a source is blind,
// and both are successful reads. This resolves always and hands the code to
// the classifier as data.
function realExec(argv, opts) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1),
      { maxBuffer: 8 * 1024 * 1024, timeout: (opts && opts.timeoutMs) || EXEC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                  stdout: stdout || '', stderr: stderr || '',
                  timedOut: !!(err && err.killed) });
      });
  });
}

// No hardcoded home anywhere: shareability.test.js fails the build over it,
// and this file has to work on a machine that is not the author's.
function resolveMcBin(env, homeDir) {
  if (env && env.PRQ_MC_BIN) return { bin: env.PRQ_MC_BIN, configured: true };
  const root = (env && env.CLAUDE_CONFIG_DIR) || path.join(homeDir || os.homedir(), '.claude');
  return { bin: path.join(root, 'mission-control', 'bin', 'mc'), configured: false };
}

function makeMissionReader(opts) {
  const exec = opts.exec || realExec;
  const exists = opts.exists || ((p) => fs.existsSync(p));
  const now = opts.now || Date.now;
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();

  let cached = null;
  let cachedAt = -Infinity;
  let inFlight = null;

  async function build(fresh) {
    const { bin, configured } = resolveMcBin(env, homeDir);
    if (!exists(bin)) {
      const read = classifyMissionRead({ missing: true, configured });
      return payloadFrom(read, bin, null);
    }
    const statusArgv = fresh ? [bin, 'status', '--fresh'] : [bin, 'status'];
    const [st, ls] = await Promise.all([
      exec(statusArgv, { timeoutMs: EXEC_TIMEOUT_MS }),
      exec([bin, 'lease'], { timeoutMs: EXEC_TIMEOUT_MS }),
    ]);
    const read = classifyMissionRead(Object.assign({ configured: true }, st));
    return payloadFrom(read, bin, ls);
  }

  function payloadFrom(read, bin, leaseRes) {
    const snap = read.snapshot;
    let leases = { active: [], expired: [], error: null };
    if (leaseRes) {
      try {
        const parsed = JSON.parse(leaseRes.stdout || '');
        leases.active = parsed.active || [];
        leases.expired = parsed.expired || [];
      } catch (e) {
        leases.error = (leaseRes.stderr || '').split('\n')[0] || ('exit ' + leaseRes.code);
      }
    }
    const generatedAt = snap ? snap.generatedAt : null;
    return {
      status: read.status,
      mcBin: bin,
      generatedAt: generatedAt,
      ageMs: generatedAt ? Math.max(0, now() - Date.parse(generatedAt)) : null,
      sources: snap ? snap.sources : [],
      ask: snap ? (snap.ask || []) : [],
      deferred: snap ? (snap.deferred || []).length || 0 : 0,
      take: snap ? (snap.take || {}) : {},
      leases: leases,
      error: read.error,
    };
  }

  return async function read(args) {
    const fresh = !!(args && args.fresh);
    if (!fresh && cached && (now() - cachedAt) < ttlMs) return cached;
    // Single-flight: the panel polls, and two overlapping polls must never
    // become two `mc status` passes — each one costs gh round-trips.
    if (inFlight) return inFlight;
    inFlight = build(fresh)
      .then((p) => { cached = p; cachedAt = now(); return p; })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { resolveMcBin, makeMissionReader, realExec, DEFAULT_TTL_MS, EXEC_TIMEOUT_MS };
