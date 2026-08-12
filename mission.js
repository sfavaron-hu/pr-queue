// Shared pure logic for the mission-control cards. Loaded both as a browser
// <script src> (globals) and via require() in Node — see the dual-export
// footer, same discipline as classify.js. No dependencies, no IO.

// mc's exit code is a CONTRACT, not a failure signal: 10 = there are
// questions, 4 = degraded, 3 = some source is blind, 0 = clean
// (mission-control/src/cli.js:86-93). Reading "exit != 0" as broken renders a
// pass that merely has questions as a crash, which is the worst possible
// failure mode for a tool whose whole job is telling you what needs a
// decision. Success is "did the JSON parse", full stop.
var MISSION_STATES = Object.freeze(['ok', 'degraded', 'absent', 'broken', 'off']);

// A snapshot cached by an older mc can carry the legacy `no-check`, which mc
// itself folds into `broken` (mission-control/src/status.js:22). Without this
// the value falls through every known branch and no card paints it at all.
function normalizeSourceStatus(status) {
  return status === 'no-check' ? 'broken' : status;
}

function classifyMissionRead(read) {
  var r = read || {};
  if (r.missing) {
    // Not configured and not there = a pr-queue user who never installed
    // mission-control. Explicitly configured and not there = a broken setup.
    return { status: r.configured ? 'broken' : 'off', snapshot: null,
             error: r.configured ? { code: null, stderr: 'no existe el binario de mc', timedOut: false } : null };
  }
  var snapshot = null;
  try { snapshot = JSON.parse(r.stdout || ''); } catch (e) { snapshot = null; }
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.sources)) {
    return { status: 'broken', snapshot: null,
             error: { code: typeof r.code === 'number' ? r.code : null,
                      stderr: (r.stderr || '').split('\n')[0] || '', timedOut: !!r.timedOut } };
  }
  return { status: r.code === 4 ? 'degraded' : 'ok', snapshot: snapshot, error: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MISSION_STATES: MISSION_STATES,
                     normalizeSourceStatus: normalizeSourceStatus,
                     classifyMissionRead: classifyMissionRead };
}
