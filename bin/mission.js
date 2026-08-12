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
// mc's own disk cache lasts 5 minutes and nothing else warms it (the
// heartbeat's `work` check runs the drain, not `mc status`), so this mirrors
// that TTL: past it, mc's cached answer is old enough to be worth replacing.
const DEFAULT_STALE_AFTER_MS = 300000;
// Only the detached background refresh gets this long: measured 133s for a
// real cold `mc status --fresh` against gh + Jira, so 20s (EXEC_TIMEOUT_MS)
// would almost always time it out. The foreground path never sees this value.
const DEFAULT_FRESH_TIMEOUT_MS = 180000;

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
  const staleAfterMs = typeof opts.staleAfterMs === 'number' ? opts.staleAfterMs : DEFAULT_STALE_AFTER_MS;
  const freshTimeoutMs = typeof opts.freshTimeoutMs === 'number' ? opts.freshTimeoutMs : DEFAULT_FRESH_TIMEOUT_MS;
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();

  let cached = null;
  let cachedAt = -Infinity;
  let inFlight = null;
  let inFlightFresh = false;

  async function build(fresh, statusTimeoutMs) {
    const { bin, configured } = resolveMcBin(env, homeDir);
    if (!exists(bin)) {
      const read = classifyMissionRead({ missing: true, configured });
      return payloadFrom(read, bin, null);
    }
    const statusArgv = fresh ? [bin, 'status', '--fresh'] : [bin, 'status'];
    const [st, ls] = await Promise.all([
      exec(statusArgv, { timeoutMs: statusTimeoutMs || EXEC_TIMEOUT_MS }),
      exec([bin, 'lease'], { timeoutMs: EXEC_TIMEOUT_MS }),
    ]);
    const read = classifyMissionRead(Object.assign({ configured: true }, st));
    return payloadFrom(read, bin, ls);
  }

  // The browser must never pay the cold path: 133s measured against the real
  // mc, versus 0.06s when mc's own 5-minute cache is warm. So the foreground
  // always serves what mc already has and, when that is stale, kicks a
  // detached refresh whose result the NEXT read serves. Serving something old
  // is honest as long as the card says how old — which is what ageMs is for.
  let refreshing = false;
  function kickRefresh() {
    if (refreshing) return;            // never stack background passes
    refreshing = true;
    build(true, freshTimeoutMs)
      .then((out) => { cached = out; cachedAt = now(); })
      .catch(() => { /* the next read reports it; a failed refresh is not fatal */ })
      .finally(() => { refreshing = false; });
  }

  // Deliberately NOT registered on inFlight/inFlightFresh: a foreground
  // `fresh` request must never be absorbed into this detached pass (which can
  // run up to freshTimeoutMs) — it always gets its own build, capped at the
  // ordinary EXEC_TIMEOUT_MS, per the single-flight contract above `read`.
  function maybeKickRefresh(payload) {
    if (payload && typeof payload.ageMs === 'number' && payload.ageMs > staleAfterMs) {
      kickRefresh();
      payload.refreshing = true;
    }
    return payload;
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
      refreshing: false,
    };
  }

  return async function read(args) {
    const fresh = !!(args && args.fresh);
    // Any non-fresh return path — cache hit, single-flight join, or a build
    // this call owns — passes through the same staleness check, so a stale
    // answer never leaves without kicking (or having already kicked) the one
    // background refresh that will replace it. A `fresh` caller gets exactly
    // what it asked mc to re-derive, unflagged.
    if (!fresh && cached && (now() - cachedAt) < ttlMs) return maybeKickRefresh(cached);
    // Single-flight: the panel polls, and two overlapping polls must never
    // become two `mc status` passes — each one costs gh round-trips.
    //
    // But a `fresh` caller may only join a build that is ITSELF fresh. Riding
    // along on a non-fresh build hands back the very answer they asked mc to
    // re-derive, silently — the refresh button would lie. The reverse is fine:
    // a plain read joins a fresh build, which is strictly better data.
    if (inFlight && (inFlightFresh || !fresh)) {
      const joined = await inFlight;
      return fresh ? joined : maybeKickRefresh(joined);
    }
    const p = build(fresh).then((out) => { cached = out; cachedAt = now(); return out; });
    inFlight = p;
    inFlightFresh = fresh;
    // Only the build that still owns the slot may clear it: with two builds in
    // flight, the first to settle would otherwise unregister the second.
    p.finally(() => { if (inFlight === p) { inFlight = null; inFlightFresh = false; } });
    const out = await p;
    return fresh ? out : maybeKickRefresh(out);
  };
}

module.exports = { resolveMcBin, makeMissionReader, realExec, DEFAULT_TTL_MS, EXEC_TIMEOUT_MS,
                   DEFAULT_STALE_AFTER_MS, DEFAULT_FRESH_TIMEOUT_MS };
