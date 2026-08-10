// Shared pure logic. Loaded both as a browser <script src> (globals) and
// via require() in Node (see the dual-export footer). No dependencies, no IO.

var COLD_DAYS = 14;

// Every field the local↔PR join and classify() read off a PR. It is the
// contract assist/prs.js must emit and the browser's enrichOwnPR already
// emits (as a superset). Frozen so a typo'd push can't mutate it.
// `closed` means closed WITHOUT merging — a deliberate "no, not this". It is
// separate from `merged` because the two demand opposite handling: merged work is
// consumed (its worktree is disposable), whereas closed work was rejected and
// must simply stop being offered. Both are equally "not open", and every
// predicate below that used to spell that `merged !== true` was silently reading
// a closed PR as open. Producers that never fetch closed PRs (github.js, the
// browser path) leave it undefined, which every check treats as today.
var PR_CONTRACT_FIELDS = Object.freeze([
  'owner', 'repo', 'number', 'title', 'url', 'headRef', 'draft', 'merged',
  'closed', 'ci', 'approved', 'changesReq', 'conflicts', 'newComments',
  'humanReviews', 'updatedAt',
]);

// The one place "this PR is neither merged nor abandoned" is decided, so a new
// terminal state cannot be added without every caller inheriting it.
function prIsOpen(pr) { return pr.merged !== true && pr.closed !== true; }

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

var TURN_WINDOW_MS = 48 * 60 * 60 * 1000;
var COLD_MS = COLD_DAYS * 24 * 60 * 60 * 1000;

function toMs(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function lastActivity(proc, prs) {
  var best = typeof proc.lastLocalActivity === 'number' ? proc.lastLocalActivity : null;
  (prs || []).forEach(function (p) {
    var ts = toMs(p.updatedAt);
    if (ts !== null && (best === null || ts > best)) best = ts;
  });
  return best;
}

function classify(proc, prs, now) {
  var list = prs || [];

  var yourMove = list.some(function (p) {
    return p.changesReq === true
      || (p.newComments  || 0) > 0
      || (p.newChanges   || 0) > 0
      || (p.newApprovals || 0) > 0
      || p.ci === 'failed'
      || p.conflicts === true;
  });
  if (yourMove) return 'turno';

  var local = typeof proc.lastLocalActivity === 'number' ? proc.lastLocalActivity : null;
  if (local !== null && now - local <= TURN_WINDOW_MS) return 'turno';

  // Must be checked before the waiting branch below: a merged PR typically
  // carries humanReviews === 0 (nobody needs to review it anymore), and
  // "esperando"'s own rule ("PR open with no human review yet") would
  // otherwise misclassify finished work as waiting on someone. Requires no
  // open PR on the process — an open PR alongside a merged one still means
  // there's live work, and the open PR should decide instead.
  var hasMerged = list.some(function (p) { return p.merged === true; });
  var hasOpen = list.some(prIsOpen);
  if (hasMerged && !hasOpen) return 'mergeado';

  // Every PR on the process was closed without merging: the work was dropped on
  // purpose. Falling through would land on 'esperando' (a closed PR has
  // humanReviews === 0), which reads as "someone owes you a review" for a PR
  // nobody will ever look at again. 'frio' is the honest state — it is dormant
  // work, and the gate offers to archive it rather than to chase a review.
  if (list.length > 0 && !hasMerged && !hasOpen) return 'frio';

  var waiting = list.some(function (p) {
    return p.ci === 'pending' || (p.humanReviews || 0) === 0;
  });
  if (waiting) return 'esperando';

  var last = lastActivity(proc, list);
  if (last === null) return 'frio';
  // Not your move and nobody is blocking it: set down, not dead. Calling this
  // "esperando" would claim someone is blocking a process with no PR.
  return (now - last > COLD_MS) ? 'frio' : 'pausa';
}

// Allowlists a URL's scheme to http/https, rejecting everything else —
// `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative `//host`,
// and any scheme-confusion trick (leading whitespace, embedded tabs/newlines,
// mixed case) that a hand-rolled regex or `startsWith` denylist would miss.
// `new URL()` does the real scheme parsing; a relative/protocol-relative
// value has no scheme to resolve without a base and throws, which lands in
// the catch and is rejected too. Returns the value unchanged (not a re-
// serialized URL) so callers get back exactly what they passed in.
//
// Shared here (not in collect-parse.js or local.js) because it is a security
// control applied at two boundaries — a hostile `prUrl` entering the payload
// in collect-parse.js, and every href the renderer trusts in local.js — and
// classify.js is the one file already loaded by both runtimes.
function safeHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    var u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? value : null;
  } catch (e) {
    return null;
  }
}

// mergeado sorts last: finished work, and this panel answers "what should I
// work on" — not "what did I already finish".
var STATE_ORDER = { turno: 0, esperando: 1, pausa: 2, frio: 3, mergeado: 4 };

function sortProcesses(rows, now) {
  return rows.slice().sort(function (a, b) {
    var sa = STATE_ORDER[classify(a.proc, a.prs, now)];
    var sb = STATE_ORDER[classify(b.proc, b.prs, now)];
    if (sa !== sb) return sa - sb;
    // Within every state, newest first: recently touched work is easier to pick back up
    // than something forgotten for weeks. Rows with no known activity still sort last.
    var la = lastActivity(a.proc, a.prs);
    var lb = lastActivity(b.proc, b.prs);
    if (la === null && lb === null) return 0;
    if (la === null) return 1;
    if (lb === null) return -1;
    return lb - la;
  });
}

// ── The "con PR / sin PR" chips ──
//
// Two chips, three states. No chip selected means *todos*: the filter is
// opt-in and its off state is the whole list, so a fresh load can never be
// hiding work you don't know about.
var PR_FILTER_ALL = null;

// Whether a row's work exists as a PR. Deliberately the very same test
// procCardHTML already uses for the blue `proc-has-pr` left edge and the
// "sin PR" badge (`prs.length > 0`) — the chips have to partition the list
// exactly the way the cards already look, or a card wearing the blue edge
// could survive a "sin PR" filter.
function rowHasPR(row) {
  return !!(row && row.prs && row.prs.length > 0);
}

// Whether a row has a PR that is open and not a draft, and whether it has a
// draft one. Deliberately `some`, matching how procCardHTML aggregates its
// badges across a multi-repo row (`prs.some(x => x.draft)`) — a process with a
// draft in one repo and a ready PR in another genuinely is both, and shows up
// under either chip rather than being forced into one.
//
// A merged PR is neither: it isn't open, and `draft` on a merged PR is a
// contradiction the GitHub API doesn't produce. So a mergeado row disappears
// under either of these chips — which is why they carry counts that can sum to
// less than the "con PR" total, and why nothing here silently reinterprets
// "abierto" as "open including drafts". Draft is the distinction being drawn.
//
// A closed-unmerged PR is excluded on the same grounds, via prIsOpen. GitHub
// keeps `isDraft: true` on a draft that was closed, so testing only `draft`
// would file abandoned drafts under the "draft" chip as if they were still
// awaiting work — real case: react-workflows#6, a draft closed unmerged.
function rowHasOpenPR(row) {
  return !!(row && row.prs && row.prs.some(function (p) {
    return prIsOpen(p) && p.draft !== true;
  }));
}

function rowHasDraftPR(row) {
  return !!(row && row.prs && row.prs.some(function (p) {
    return prIsOpen(p) && p.draft === true;
  }));
}

// Radio-with-an-off-state, shared by both chip rows: clicking the selected
// chip clears the filter, clicking another one replaces it (the previous one
// turns off). Returns the next value so callers hold no toggle logic of their
// own. A mode outside `allowed` leaves the current selection alone rather than
// silently clearing it.
function nextChipFilter(current, clicked, allowed) {
  if ((allowed || []).indexOf(clicked) === -1) return current;
  return current === clicked ? PR_FILTER_ALL : clicked;
}

// Anything that isn't one of the two known modes — `null` included — means
// *todos* and returns every row. Always a copy, never the caller's array.
function filterRowsByPR(rows, mode) {
  var list = rows || [];
  if (mode !== 'con' && mode !== 'sin') return list.slice();
  var want = mode === 'con';
  return list.filter(function (r) { return rowHasPR(r) === want; });
}

// The second row's filter: which PR *status* to keep. Only ever applied to
// rows that already passed `con PR` (see local.js) — asking "abierto o draft"
// of a row with no PR at all has no answer.
var PR_STATUS_TESTS = { abierto: rowHasOpenPR, draft: rowHasDraftPR };

function filterRowsByPRStatus(rows, mode) {
  var list = rows || [];
  var test = PR_STATUS_TESTS[mode];
  return test ? list.filter(test) : list.slice();
}

// `headRef` is the preferred source, but it can be absent: the panel enriches
// merged PRs with one (github.js fetchHeadRef) and that extra GET is allowed to
// fail. The title is the fallback because a Jira ticket normally appears there
// too. Open PRs always have `headRef` and keep using it, unchanged.
function prTicket(pr) {
  if (pr.headRef) return extractTicket(pr.headRef);
  return pr.title ? extractTicket(pr.title) : null;
}

// Attaches each PR in `ownPRs` to at most one process: an exact `headRef`
// match against `proc.branches` wins if one exists; failing that, the first
// process (in payload order) whose `ticket` equals the PR's extracted ticket,
// provided both are non-null. This is what merges a PR on
// `feat/SQSH-3954-copy` into the same row as a worktree on
// `feat/SQSH-3954-web` — same ticket, one process — while still preferring
// the precise branch match when one exists. Two passes over `ownPRs`, not
// one, so an exact match anywhere always outranks a ticket match anywhere,
// matching the priority order the spec calls for. Returns the per-process PR
// lists alongside whatever PR matched nothing, for synthesizeProcesses() to
// turn into rows of its own.
function attachOwnPRs(processes, ownPRs) {
  const rows = processes.map(proc => ({ proc, prs: [] }));
  const afterExact = [];
  const unmatched = [];

  ownPRs.forEach(pr => {
    const row = pr.headRef ? rows.find(r => r.proc.branches.indexOf(pr.headRef) !== -1) : null;
    if (row) row.prs.push(pr);
    else afterExact.push(pr);
  });

  afterExact.forEach(pr => {
    const ticket = prTicket(pr);
    const row = ticket ? rows.find(r => r.proc.ticket && r.proc.ticket === ticket) : null;
    if (row) row.prs.push(pr);
    else unmatched.push(pr);
  });

  return { rows, unmatched };
}

// One synthetic process per distinct ticket (or, lacking a ticket, per
// branch) among PRs that attachOwnPRs() matched nowhere — a PR pushed
// straight to GitHub with no local worktree still gets a card instead of
// vanishing along with the "Mis PRs" column it used to live in.
// `worktrees`/`sessions` stay empty and `lastLocalActivity` stays null, which
// is what keeps this out of the 48h own-activity window: classify() falls
// straight through turno's local-activity check to the PR-driven
// esperando/pausa/frío branches, so no classifier change is needed. `ticket`
// mirrors a real process's shape (non-null only when one was found) so
// downstream code (the "sin ticket" badge) treats it identically. `synthetic`
// is the marker procCardHTML uses to print "sin worktree local" in place of
// the (necessarily empty) repo list. Two PRs that resolve to the same key
// share one process, both attached to it.
function synthesizeProcesses(unmatchedPRs) {
  const map = new Map();
  unmatchedPRs.forEach(pr => {
    const ticket = prTicket(pr);
    // `headRef` can be null on a merged PR even now that the panel's fetchHeadRef
    // fills it in: that extra GET is allowed to fail (a PR worth listing is not
    // worth dropping over an unreadable branch name). So owner/repo#number stays
    // the last resort — it is the only component always present and always
    // unique, whereas falling through to a null headRef would collapse every
    // ticket-less merged PR onto one shared key.
    const key = ticket || pr.headRef || `${pr.owner}/${pr.repo}#${pr.number}`;
    if (!map.has(key)) {
      map.set(key, {
        proc: { key: key, ticket: ticket || null, branches: [], worktrees: [],
                sessions: [], lastLocalActivity: null, synthetic: true },
        prs: [],
      });
    }
    const row = map.get(key);
    if (pr.headRef && row.proc.branches.indexOf(pr.headRef) === -1) row.proc.branches.push(pr.headRef);
    row.prs.push(pr);
  });
  return Array.from(map.values());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLD_DAYS: COLD_DAYS, extractTicket: extractTicket,
                     processKey: processKey, groupProcesses: groupProcesses,
                     attachSessions: attachSessions, lastActivity: lastActivity,
                     classify: classify, sortProcesses: sortProcesses,
                     safeHttpUrl: safeHttpUrl, PR_FILTER_ALL: PR_FILTER_ALL,
                     prIsOpen: prIsOpen,
                     rowHasPR: rowHasPR, rowHasOpenPR: rowHasOpenPR,
                     rowHasDraftPR: rowHasDraftPR, nextChipFilter: nextChipFilter,
                     filterRowsByPR: filterRowsByPR,
                     filterRowsByPRStatus: filterRowsByPRStatus,
                     prTicket: prTicket, attachOwnPRs: attachOwnPRs,
                     synthesizeProcesses: synthesizeProcesses,
                     PR_CONTRACT_FIELDS: PR_CONTRACT_FIELDS };
}
