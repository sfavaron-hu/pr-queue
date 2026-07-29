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
// them is the whole reason we do not use the file's mtime.
function parseTranscriptTail(text) {
  const out = { lastTs: null, lastCwd: null, prLink: null };
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
      out.prLink = { number: o.prNumber, repo: o.prRepository || null, url: o.prUrl || null };
    }
    if (out.lastTs !== null && out.lastCwd !== null && out.prLink !== null) break;
  }
  return out;
}

module.exports = { parseWorktrees, parseStatusShort, parseAgents, parseTranscriptTail };
