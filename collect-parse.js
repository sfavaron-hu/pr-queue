// Pure parsers for local command output. No IO, no dependencies.

// safeHttpUrl lives in classify.js — the one file already shared by both the
// browser (local.js) and Node (this file) runtimes — so the scheme-allowlist
// security control has exactly one implementation. Re-exported below so
// existing tests can keep importing it from here.
const { safeHttpUrl } = require('./classify.js');

// `isPrimary` marks the repo's main working tree, which `git worktree list`
// always reports FIRST and never labels — the porcelain format has no marker
// for it (checked against git 2.50.1), so position is the only signal there is.
// It matters because the main working tree cannot be removed: `git worktree
// remove <main>` exits 128 ("is a main working tree"). Without this field a
// main checkout parked on a merged branch is indistinguishable from a
// disposable worktree, and the gate emits a removal that fails 128 on every
// single pass (observed on hu-translations and material-hu, both of whose main
// checkouts sat on merged branches).
function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null,
              detached: false, prunable: false, isPrimary: out.length === 0 };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseStatusShort(stdout) {
  return String(stdout).split('\n').filter(l => l.trim() !== '').length;
}

// The first few changed paths, with their status codes, so a consumer can say
// WHAT is uncommitted rather than only how much. A bare count cannot be acted on:
// asked "1 file uncommitted, commit it?", the honest answer is "depends what it
// is" — and it genuinely does. The real case that motivated this was a single
// modified file holding a `// TEMP — DO NOT COMMIT` feature-flag override, where
// the count alone pointed at exactly the wrong answer.
//
// Capped because this rides in a question's description, not in a diff view;
// past a handful of paths the shape of the change is what matters, not the list.
const DIRTY_SAMPLE = 5;
function parseStatusFiles(stdout, limit) {
  const max = typeof limit === 'number' ? limit : DIRTY_SAMPLE;
  return String(stdout).split('\n')
    .filter(l => l.trim() !== '')
    // `XY path` — keep both, trimmed: the code says modified vs untracked vs
    // deleted, which is most of what makes the decision.
    .map(l => ({ code: l.slice(0, 2).trim(), path: l.slice(2).trim() }))
    .slice(0, max);
}

function parseAgents(stdout) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map(a => ({
    sessionId: a.sessionId || null,
    name: a.name || null,
    kind: a.kind || null,
    status: a.status || a.state || null,
    cwd: a.cwd || null,
    startedAt: a.startedAt || null,
  }));
}

// Scans a transcript tail backwards. Records are one JSON object per line;
// the first line is usually truncated by the 64KB read and must be tolerated.
// Trailing ai-title/mode/permission-mode records have no timestamp — skipping
// them is the whole reason we do not use the file's mtime. The ai-title record
// itself never carries a timestamp either, so "newest wins" just means the
// first one hit while scanning backwards (the transcript is append-only).
function parseTranscriptTail(text) {
  const out = { lastTs: null, lastCwd: null, prLink: null, aiTitle: null };
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }  // truncated line
    if (out.lastTs === null && o.timestamp) {
      const t = new Date(o.timestamp).getTime();
      if (!isNaN(t)) out.lastTs = t;
    }
    if (out.lastCwd === null && o.cwd) out.lastCwd = o.cwd;
    if (out.prLink === null && o.type === 'pr-link' && o.prNumber) {
      out.prLink = { number: o.prNumber, repo: o.prRepository || null, url: safeHttpUrl(o.prUrl) };
    }
    if (out.aiTitle === null && o.type === 'ai-title' && o.aiTitle) {
      out.aiTitle = o.aiTitle;
    }
    if (out.lastTs !== null && out.lastCwd !== null && out.prLink !== null && out.aiTitle !== null) break;
  }
  return out;
}

// Parses `git log -1 --format=%ct%x00%s` output: epoch seconds and the
// subject, split on the FIRST NUL only — a commit subject can itself contain
// anything (including more NULs, in theory) so it must never be assumed
// non-empty or NUL-free.
function parseLastCommitLog(stdout) {
  const raw = String(stdout).trim();
  const sep = raw.indexOf('\0');
  const secsStr = sep === -1 ? raw : raw.slice(0, sep);
  const subject = sep === -1 ? '' : raw.slice(sep + 1);
  return { ts: secsStr ? Number(secsStr) * 1000 : null, subject: subject || null };
}

// Parses `git log --format=%ct%x00%s origin/<base>..HEAD`: zero or more
// commits unique to this branch (newest first), one per line since %s is a
// single-line subject. Splitting on the first NUL only mirrors
// parseLastCommitLog, for the same reason. An empty range (0 commits ahead)
// is not an error — it means the branch has made no commits of its own yet,
// so there is no own-work subject to report; callers must not fall back to
// HEAD's subject in that case, since HEAD may be sitting on someone else's
// commit (e.g. a freshly created worktree on the base branch's tip).
function parseCommitRangeLog(stdout) {
  const lines = String(stdout).split('\n').filter(l => l !== '');
  if (lines.length === 0) return { count: 0, subject: null };
  const sep = lines[0].indexOf('\0');
  const subject = sep === -1 ? '' : lines[0].slice(sep + 1);
  return { count: lines.length, subject: subject || null };
}

// Parses `owner/name` out of a real `git remote get-url origin` value. Handles
// the SSH form (git@github.com:Owner/Repo.git) and the HTTPS form
// (https://github.com/Owner/Repo.git), each with or without the `.git`
// suffix. Anything else — missing remote, non-GitHub host, unparseable text —
// returns null rather than guessing.
function parseGithubSlug(remoteUrl) {
  const s = String(remoteUrl || '').trim();
  if (!s) return null;
  let m = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

module.exports = { parseWorktrees, parseStatusShort, parseStatusFiles, parseAgents, parseTranscriptTail,
                    parseGithubSlug, parseLastCommitLog, parseCommitRangeLog, safeHttpUrl };
