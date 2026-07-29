// Shared pure logic. Loaded both as a browser <script src> (globals) and
// via require() in Node (see the dual-export footer). No dependencies, no IO.

var COLD_DAYS = 14;

var TICKET_RE = /\b([A-Z]{3,5}-\d+)\b/;

function extractTicket(branch) {
  if (!branch) return null;
  var m = String(branch).match(TICKET_RE);
  return m ? m[1] : null;
}

function processKey(item) {
  // item: { branch, path }
  var ticket = extractTicket(item.branch);
  if (ticket) return ticket;
  if (item.branch) return item.branch;
  return item.path || 'unknown';
}

// Resolves each session to the worktree that owns its cwd. A session's cwd is
// frequently the workspace root rather than a worktree, and the transcript's
// gitBranch reports wherever the session started — so cwd containment is the
// only reliable local signal, and anything unresolved must stay loose rather
// than becoming a process keyed by its cwd.
function attachSessions(sessions, worktrees) {
  var paths = (worktrees || [])
    .filter(function (w) { return w.path && w.branch; })
    // Longest path first so a nested worktree beats its parent repo.
    .sort(function (a, b) { return b.path.length - a.path.length; });

  var attached = [], loose = [];

  (sessions || []).forEach(function (s) {
    var cwd = s.cwd;
    var hit = cwd ? paths.find(function (w) {
      // Exact match, or cwd is inside the worktree. The separator check stops
      // /w/humand-web-other from matching /w/humand-web.
      return cwd === w.path || cwd.indexOf(w.path + '/') === 0;
    }) : null;

    if (hit) attached.push(Object.assign({}, s, { branch: hit.branch }));
    else loose.push(s);
  });

  return { attached: attached, loose: loose };
}

function groupProcesses(input) {
  var worktrees = (input && input.worktrees) || [];
  var sessions  = (input && input.sessions)  || [];
  var map = new Map();

  function ensure(key, ticket) {
    if (!map.has(key)) {
      map.set(key, { key: key, ticket: ticket || null, branches: [],
                     worktrees: [], sessions: [], lastLocalActivity: null });
    }
    return map.get(key);
  }

  function noteBranch(proc, branch) {
    if (branch && proc.branches.indexOf(branch) === -1) proc.branches.push(branch);
  }

  function bump(proc, ts) {
    if (typeof ts === 'number' && (proc.lastLocalActivity === null || ts > proc.lastLocalActivity)) {
      proc.lastLocalActivity = ts;
    }
  }

  worktrees.forEach(function (wt) {
    var proc = ensure(processKey(wt), extractTicket(wt.branch));
    proc.worktrees.push(wt);
    noteBranch(proc, wt.branch);
    bump(proc, wt.lastCommit);
  });

  sessions.forEach(function (s) {
    // A session with no branch is unattached and belongs in looseSessions.
    // Keying it by cwd would collapse every root-cwd session into one row.
    if (!s.branch) return;
    var proc = ensure(processKey({ branch: s.branch }), extractTicket(s.branch));
    proc.sessions.push(s);
    noteBranch(proc, s.branch);
    bump(proc, s.lastActivity);
  });

  return Array.from(map.values());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLD_DAYS: COLD_DAYS, extractTicket: extractTicket,
                     processKey: processKey, groupProcesses: groupProcesses,
                     attachSessions: attachSessions };
}
