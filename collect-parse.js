// Pure parsers for local command output. No IO, no dependencies.

function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null,
              detached: false, prunable: false };
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

// Allowlists a URL's scheme to http/https, rejecting everything else —
// `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative `//host`,
// and any scheme-confusion trick (leading whitespace, embedded tabs/newlines,
// mixed case) that a hand-rolled regex or `startsWith` denylist would miss.
// `new URL()` does the real scheme parsing; a relative/protocol-relative
// value has no scheme to resolve without a base and throws, which lands in
// the catch and is rejected too. Returns the value unchanged (not a re-
// serialized URL) so callers get back exactly what they passed in.
function safeHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? value : null;
  } catch {
    return null;
  }
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

module.exports = { parseWorktrees, parseStatusShort, parseAgents, parseTranscriptTail,
                    parseGithubSlug, parseLastCommitLog, safeHttpUrl };
