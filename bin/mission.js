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
// mc's own disk cache lasts 5 minutes (300000ms) and nothing else warms it
// (the heartbeat's `work` check runs the drain, not `mc status`). Equalling
// that 300000 exactly would mean the reader's own 60s sampling (DEFAULT_TTL_MS)
// and mc's cache expiry cross the line in the SAME poll: the first read that
// notices "stale" is the same one whose underlying mc cache has just gone
// cold, so it is also the read that eats the 133s rebuild and dies at the
// endpoint's 20s cap — exactly the failure this task exists to prevent.
// 240000 leaves exactly one sampling interval of margin: a read observes the
// staleness and arms the detached refresh (180s cap) BEFORE mc's own cache
// expires underneath it, with nobody waiting on that refresh.
const DEFAULT_STALE_AFTER_MS = 240000;
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

  // A broken build carries no data at all (sources: [], ask: [], ageMs:
  // null) — letting it stomp a `cached` entry that DID hold a real snapshot
  // would make the fast TTL path serve nothing where it used to serve
  // something real, merely aging. Keep the last good snapshot until a build
  // actually produces one; its ageMs keeps growing honestly in the meantime
  // (computed straight off the unchanged generatedAt), and maybeKickRefresh
  // already treats that growing age like any other stale read, so retries
  // keep firing until one lands. Only accept a broken result into `cached`
  // when there is nothing good there to lose.
  function shouldReplaceCache(next) {
    return !(next.status === 'broken' && cached && cached.status !== 'broken');
  }

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
  let backgroundInFlight = false;      // the detached-pass flag; NOT payload.refreshing (the card-facing field)
  function kickRefresh() {
    if (backgroundInFlight) return;    // never stack background passes
    backgroundInFlight = true;
    build(true, freshTimeoutMs)
      .then((out) => { if (shouldReplaceCache(out)) cached = out; cachedAt = now(); })
      .catch(() => { /* the next read reports it; a failed refresh is not fatal */ })
      .finally(() => { backgroundInFlight = false; });
  }

  // ageMs is a VIEW over generatedAt, computed fresh every time a payload is
  // handed to a caller — never stored state. Storing it once (as this used
  // to) was harmless before shouldReplaceCache existed, because every build
  // outcome overwrote `cached` and the skew was bounded by ttlMs. Now that a
  // broken build can retain the SAME cached object across an entire outage,
  // a stored ageMs would freeze at the age the good snapshot had when it was
  // built and stay there for as long as the outage lasts — understating the
  // true age on every fast-path poll, which is the exact lie this feature
  // exists to prevent. generatedAt stays the single source of truth.
  function deriveAgeMs(generatedAt) {
    return generatedAt ? Math.max(0, now() - Date.parse(generatedAt)) : null;
  }

  // Returns a fresh object, never the shared `cached`/`inFlight` reference —
  // a prior review already flagged maybeKickRefresh writing `refreshing`
  // straight onto the cached payload; serving a shallow copy per call with
  // its own ageMs and refreshing flag fixes both the frozen-age bug and the
  // shared-mutation bug at once.
  function serve(stored) {
    return Object.assign({}, stored, { ageMs: deriveAgeMs(stored.generatedAt), refreshing: false });
  }

  // Deliberately NOT registered on inFlight/inFlightFresh: a foreground
  // `fresh` request must never be absorbed into this detached pass (which can
  // run up to freshTimeoutMs) — it always gets its own build, capped at the
  // ordinary EXEC_TIMEOUT_MS, per the single-flight contract above `read`.
  function maybeKickRefresh(stored) {
    if (!stored) return stored;
    const served = serve(stored);
    // A blind read — broken, timed out, or otherwise snapshot-less — has no
    // numeric ageMs to compare against staleAfterMs. That is exactly the read
    // this task exists for: the one that hit mc's 133s cold path and got
    // killed at the endpoint's 20s cap. Treating "can't tell how old" as
    // "definitely over threshold" is what arms the one thing — kickRefresh's
    // freshTimeoutMs detached pass — that can actually recover it. A numeric
    // ageMs keeps the original over-staleAfterMs check unchanged, but now
    // decided on the just-recomputed age, not a stored one — so a retained
    // snapshot that keeps aging re-arms the refresh instead of going quiet.
    var overThreshold = typeof served.ageMs !== 'number' || served.ageMs > staleAfterMs;
    if (overThreshold) {
      kickRefresh();
      served.refreshing = true;
    }
    return served;
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
    // No ageMs/refreshing here on purpose: this object (and whatever ends up
    // in `cached`) is the pure stored snapshot. Every caller-facing view of
    // it goes through serve()/maybeKickRefresh(), which compute ageMs fresh.
    return {
      status: read.status,
      mcBin: bin,
      generatedAt: snap ? snap.generatedAt : null,
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
      return fresh ? serve(joined) : maybeKickRefresh(joined);
    }
    const p = build(fresh).then((out) => {
      if (shouldReplaceCache(out)) cached = out;
      cachedAt = now();       // reset the clock regardless, or every poll would retry synchronously
      return out;
    });
    inFlight = p;
    inFlightFresh = fresh;
    // Only the build that still owns the slot may clear it: with two builds in
    // flight, the first to settle would otherwise unregister the second.
    p.finally(() => { if (inFlight === p) { inFlight = null; inFlightFresh = false; } });
    const out = await p;
    return fresh ? serve(out) : maybeKickRefresh(out);
  };
}

module.exports = { resolveMcBin, makeMissionReader, realExec, DEFAULT_TTL_MS, EXEC_TIMEOUT_MS,
                   DEFAULT_STALE_AFTER_MS, DEFAULT_FRESH_TIMEOUT_MS };
