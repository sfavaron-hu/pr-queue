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

// The seven states, in the order classify() decides them. Each answers a
// different question, and splitting them is what keeps the badge honest:
//
//   move    something demands an action from you right now
//   merged  the work landed; only leftover local state remains
//   active  you were in this worktree in the last 48h, nothing demanding
//   review  an open, non-draft PR nobody has reviewed yet
//   ci      an open PR whose CI is still running
//   paused  quiet, but recent enough to pick back up
//   cold    quiet for longer than COLD_DAYS, or dropped on purpose
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
  if (yourMove) return 'move';

  // Checked before local recency: work that landed is finished, and saying
  // "you were here an hour ago" about it hides the one thing a merged row is
  // for — offering to clean up the worktree it left behind. Requires no open
  // PR on the process: an open PR alongside a merged one still means there's
  // live work, and the open PR should decide instead.
  var hasMerged = list.some(function (p) { return p.merged === true; });
  var hasOpen = list.some(prIsOpen);
  if (hasMerged && !hasOpen) return 'merged';

  var local = typeof proc.lastLocalActivity === 'number' ? proc.lastLocalActivity : null;
  if (local !== null && now - local <= TURN_WINDOW_MS) return 'active';

  // Every PR on the process was closed without merging: the work was dropped on
  // purpose. It is dormant work, and the gate offers to archive it rather than
  // to chase a review.
  if (list.length > 0 && !hasMerged && !hasOpen) return 'cold';

  // The nearest gate first. While CI is running that is the concrete thing
  // holding the PR up; once it is green and nobody has looked, the review is.
  // Both read `prIsOpen` directly rather than relying on the branches above:
  // a merged or closed PR carries humanReviews === 0 and would otherwise read
  // as "someone owes you a review" on a row that also has open work.
  if (list.some(function (p) { return prIsOpen(p) && p.ci === 'pending'; })) return 'ci';

  // Drafts are excluded: nobody is expected to review a draft, so an unreviewed
  // one is not waiting on a person — it is waiting on you, and falls through to
  // active/paused/cold like any other unfinished work.
  var inReview = list.some(function (p) {
    return prIsOpen(p) && p.draft !== true && (p.humanReviews || 0) === 0;
  });
  if (inReview) return 'review';

  var last = lastActivity(proc, list);
  if (last === null) return 'cold';
  // Not your move and nobody is blocking it: set down, not dead.
  return (now - last > COLD_MS) ? 'cold' : 'paused';
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

// `merged` sorts last: finished work, and this panel answers "what should I
// work on" — not "what did I already finish". `review` outranks `ci` because a
// PR waiting on a person waits for days and a PR waiting on a machine waits for
// minutes, even though `ci` is the state that wins when a PR is both.
var STATE_ORDER = { move: 0, active: 1, review: 2, ci: 3, paused: 4, cold: 5, merged: 6 };

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

// ── The "with PR / without PR" chips ──
//
// Two chips, three states. No chip selected means *all*: the filter is
// opt-in and its off state is the whole list, so a fresh load can never be
// hiding work you don't know about.
var PR_FILTER_ALL = null;

// Whether a row's work exists as a PR. Deliberately the very same test
// procCardHTML already uses for the "no PR" badge (`prs.length > 0`) — the
// chips have to partition the list exactly the way the cards already read, or
// a card the panel calls PR-backed could survive a "without PR" filter.
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
// contradiction the GitHub API doesn't produce. So a merged row disappears
// under either of these chips — which is why they carry counts that can sum to
// less than the "with PR" total, and why nothing here silently reinterprets
// "open" as "open including drafts". Draft is the distinction being drawn.
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
// *all* and returns every row. Always a copy, never the caller's array.
function filterRowsByPR(rows, mode) {
  var list = rows || [];
  if (mode !== 'with' && mode !== 'without') return list.slice();
  var want = mode === 'with';
  return list.filter(function (r) { return rowHasPR(r) === want; });
}

// The second row's filter: which PR *status* to keep. Only ever applied to
// rows that already passed `with PR` (see local.js) — asking "open or draft"
// of a row with no PR at all has no answer.
var PR_STATUS_TESTS = { open: rowHasOpenPR, draft: rowHasDraftPR };

function filterRowsByPRStatus(rows, mode) {
  var list = rows || [];
  var test = PR_STATUS_TESTS[mode];
  return test ? list.filter(test) : list.slice();
}

// Whether the "with PR / without PR" split can partition anything at all. It can
// only when at least one row has no PR — i.e. only when the payload brought
// local work (a worktree or a session) that GitHub knows nothing about.
//
// The static deploy has no sidecar, so every row is synthesized from a PR:
// "without PR" is always 0 and "with PR" is always everything, and two chips
// that cannot change the list are worse than no chips — they read as a filter
// that is broken. Also true (correctly) of a sidecar whose every worktree
// already has a PR. Callers hide the first chip row when this is false and show
// the open/draft row on its own instead, since *that* split still partitions.
function prSplitIsMeaningful(rows) {
  return (rows || []).some(function (r) { return !rowHasPR(r); });
}

// The `+N −M` diff stat a PR card shows, for a row that has exactly one PR
// carrying it. Deliberately NOT summed across a multi-PR row: the card links to
// one diff, and a pair of numbers covering two repos describes neither of them.
// `null` means "don't show it", which is the honest answer for a row that has
// no single diff to size.
//
// A PR that predates the fields (an older cache) or a merged PR out of
// loadOwnPRs's second query (which never fetches additions/deletions) carries
// no numbers, and returns null too rather than rendering a confident 0.
function rowSizeStats(row) {
  var prs = (row && row.prs) || [];
  if (prs.length !== 1) return null;
  var pr = prs[0];
  if (typeof pr.additions !== 'number' || typeof pr.deletions !== 'number') return null;
  return { additions: pr.additions, deletions: pr.deletions,
           lines: pr.additions + pr.deletions };
}

// Unseen human activity across every PR in the row: comments the owner hasn't
// opened, and reviews (approvals + change requests) they haven't seen. Summed,
// unlike rowSizeStats — a count of unread things genuinely adds up across
// repos, and the row is the thing the owner clicks.
function rowNewActivity(row) {
  var comments = 0, reviews = 0;
  ((row && row.prs) || []).forEach(function (p) {
    comments += p.newComments  || 0;
    reviews  += (p.newApprovals || 0) + (p.newChanges || 0);
  });
  return { comments: comments, reviews: reviews };
}

// The `repo #number` line under a card's process key: every repo the process
// touches, each annotated with the PR number(s) it has there.
//
// Built from the union of worktree repos and PR repos rather than one or the
// other, because either alone loses something real. Worktrees alone (what the
// panel used to print) drop the PR number — which is exactly what render.js's
// flat "My PRs" list showed in this slot, and the only thing distinguishing
// two PRs in the same repo. PRs alone drop a repo that has a worktree but no
// PR yet, which is a multi-repo process's whole point: `humand-web #9884 ·
// material-hu` says the second repo is still local, and dropping it would
// leave the row's own `diff material-hu` chip referring to a repo the card
// never names.
//
// Worktree order first (it is the payload's, i.e. the collector's), then any
// PR repo not already named. A PR missing `repo` or a numeric `number`
// contributes nothing rather than `undefined #undefined`; two PRs in one repo
// share its entry (`pr-queue #12 #14`).
function processRepoLabel(worktrees, prs) {
  var names = [];
  var seen = {};
  function push(n) { if (n && !seen[n]) { seen[n] = true; names.push(n); } }
  (worktrees || []).forEach(function (w) { push(w.repo); });
  (prs || []).forEach(function (pr) { push(pr.repo); });

  var numbers = {};
  (prs || []).forEach(function (pr) {
    if (!pr.repo || typeof pr.number !== 'number') return;
    (numbers[pr.repo] = numbers[pr.repo] || []).push('#' + pr.number);
  });

  return names.map(function (n) {
    return numbers[n] ? n + ' ' + numbers[n].join(' ') : n;
  }).join(' · ');
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
// vanishing along with the flat "My PRs" column it falls back to.
// `worktrees`/`sessions` stay empty and `lastLocalActivity` stays null, which
// is what keeps this out of the 48h own-activity window: classify() falls
// straight through the `active` check to the PR-driven review/ci/paused/cold
// branches, so no classifier change is needed. `ticket` mirrors a real
// process's shape (non-null only when one was found) so downstream code (the
// "no ticket" badge) treats it identically. `synthetic` is the marker
// procCardHTML uses to print "no local worktree" in place of
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
                     prSplitIsMeaningful: prSplitIsMeaningful,
                     processRepoLabel: processRepoLabel,
                     rowSizeStats: rowSizeStats, rowNewActivity: rowNewActivity,
                     prTicket: prTicket, attachOwnPRs: attachOwnPRs,
                     synthesizeProcesses: synthesizeProcesses,
                     PR_CONTRACT_FIELDS: PR_CONTRACT_FIELDS };
}
