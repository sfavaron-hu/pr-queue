const { test } = require('node:test');
const assert = require('node:assert');
const { parseWorktrees, parseStatusShort, parseStatusFiles, parseAgents,
        parseTranscriptTail, parseGithubSlug, parseLastCommitLog, parseCommitRangeLog,
        safeHttpUrl } = require('../collect-parse.js');

const WORKTREE_FIXTURE = `worktree /w/humand-web
HEAD 5552c1c23d5ab2a22bfd9c5cd9da130e8b86adfb
branch refs/heads/chore/no-ticket-e2e-coverage-instrumentation

worktree /w/humand-web--SQSH-3705-crashes-feed
HEAD efaf154a65d5f885516645af71b80488916e073c
branch refs/heads/fix/SQSH-3705-web-feed-seen-by-of-a-group-post-crashes-feed
prunable gitdir file points to non-existent location

worktree /w/humand-web--detached
HEAD 93f62bd5a7f27da51d6980c1c5a61a876cdd283a
detached
`;

test('parseWorktrees reads path and strips refs/heads/ from branch', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out.length, 3);
  assert.equal(out[0].path, '/w/humand-web');
  assert.equal(out[0].branch, 'chore/no-ticket-e2e-coverage-instrumentation');
  assert.equal(out[0].prunable, false);
  assert.equal(out[0].detached, false);
});

test('parseWorktrees flags prunable worktrees', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out[1].prunable, true);
  assert.equal(out[1].branch, 'fix/SQSH-3705-web-feed-seen-by-of-a-group-post-crashes-feed');
});

test('parseWorktrees flags detached worktrees with a null branch', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out[2].detached, true);
  assert.equal(out[2].branch, null);
});

test('parseWorktrees returns empty array for empty input', () => {
  assert.deepEqual(parseWorktrees(''), []);
});

// The main working tree is the one `git worktree remove` refuses with exit 128,
// and `git worktree list` never labels it — it is simply first. Everything else
// must come back false, or a consumer would skip removing a real worktree.
test('parseWorktrees marks only the first worktree as primary', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out[0].isPrimary, true);
  assert.equal(out[1].isPrimary, false);
  assert.equal(out[2].isPrimary, false);
});

// Leading blank lines are the trap: keying off "have I seen a `worktree` line
// yet" rather than a raw line counter is what keeps the first real entry primary.
test('parseWorktrees marks the first entry primary despite leading blank lines', () => {
  const out = parseWorktrees(`\n\n${WORKTREE_FIXTURE}`);
  assert.equal(out.length, 3);
  assert.equal(out[0].isPrimary, true);
  assert.equal(out[1].isPrimary, false);
});

test('parseStatusShort counts changed files', () => {
  assert.equal(parseStatusShort('?? AGENTS.md\n M src/a.ts\n M src/b.ts\n'), 3);
});

test('parseStatusShort returns 0 for a clean tree', () => {
  assert.equal(parseStatusShort(''), 0);
  assert.equal(parseStatusShort('\n'), 0);
});

test('parseStatusShort ignores untracked worktree-container dirs (not real work)', () => {
  // A merged worktree with only `?? .worktrees/` must read as clean (0), so it
  // is eligible for autonomous removal and produces no spurious commit question.
  assert.equal(parseStatusShort('?? .worktrees/\n'), 0);
  assert.equal(parseStatusShort('?? .claude/worktrees/\n'), 0);
  // Mixed: the container is dropped, the real modified file still counts.
  assert.equal(parseStatusShort(' M package.json\n?? .worktrees/\n'), 1);
  // A real untracked file named similarly is NOT dropped — only exact containers.
  assert.equal(parseStatusShort('?? .worktrees-notes.md\n'), 1);
  assert.equal(parseStatusShort('?? src/.worktrees/thing.ts\n'), 1);
});

test('parseAgents normalizes status from status or state', () => {
  const fixture = JSON.stringify([
    { id: '50f65449', cwd: '/w', kind: 'background', startedAt: 1782329044156,
      sessionId: '50f65449-e6e7-4a91-a95a-959179f758d0',
      name: 'Migrar modulos', state: 'blocked' },
    { pid: 75713, cwd: '/w', kind: 'interactive', startedAt: 1783966404484,
      sessionId: '49218af4-029d-4668-9ad2-3c3ee5bbc03d',
      name: 'humand-33', status: 'idle' },
  ]);
  const out = parseAgents(fixture);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'blocked');
  assert.equal(out[1].status, 'idle');
  assert.equal(out[1].name, 'humand-33');
});

test('parseAgents returns empty array on unparseable input', () => {
  assert.deepEqual(parseAgents('not json'), []);
  assert.deepEqual(parseAgents(''), []);
});

// Real transcript tail. The trailing ai-title/mode/permission-mode records
// carry NO timestamp and are what makes file mtime unusable — they are
// appended by bookkeeping hours after the last real message.
const TAIL_FIXTURE = [
  JSON.stringify({ type: 'user', cwd: '/w/humand-web--SQSH-3239', timestamp: '2026-07-28T13:40:00.000Z' }),
  JSON.stringify({ type: 'pr-link', sessionId: 's1', prNumber: 9294,
    prUrl: 'https://github.com/HumandDev/humand-web/pull/9294',
    prRepository: 'HumandDev/humand-web', timestamp: '2026-07-28T13:49:04.352Z' }),
  JSON.stringify({ type: 'system', timestamp: '2026-07-28T13:52:17.647Z' }),
  JSON.stringify({ type: 'ai-title' }),
  JSON.stringify({ type: 'mode' }),
  JSON.stringify({ type: 'permission-mode' }),
].join('\n') + '\n';

test('parseTranscriptTail uses the last real timestamp, not the trailing records', () => {
  const out = parseTranscriptTail(TAIL_FIXTURE);
  assert.equal(out.lastTs, new Date('2026-07-28T13:52:17.647Z').getTime());
});

test('parseTranscriptTail finds the last cwd', () => {
  assert.equal(parseTranscriptTail(TAIL_FIXTURE).lastCwd, '/w/humand-web--SQSH-3239');
});

test('parseTranscriptTail extracts the pr-link', () => {
  const { prLink } = parseTranscriptTail(TAIL_FIXTURE);
  assert.equal(prLink.number, 9294);
  assert.equal(prLink.repo, 'HumandDev/humand-web');
  assert.equal(prLink.url, 'https://github.com/HumandDev/humand-web/pull/9294');
});

test('parseTranscriptTail returns the newest pr-link when there are several', () => {
  const text = [
    JSON.stringify({ type: 'pr-link', prNumber: 1, prUrl: 'u1', prRepository: 'o/r',
      timestamp: '2026-07-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'pr-link', prNumber: 2, prUrl: 'u2', prRepository: 'o/r',
      timestamp: '2026-07-20T00:00:00.000Z' }),
  ].join('\n');
  assert.equal(parseTranscriptTail(text).prLink.number, 2);
});

test('parseTranscriptTail survives a truncated first line', () => {
  // Tail-reading 64KB almost always cuts the first line mid-JSON.
  const text = '{"type":"user","timest' + '\n' + TAIL_FIXTURE;
  assert.equal(parseTranscriptTail(text).lastTs, new Date('2026-07-28T13:52:17.647Z').getTime());
});

test('parseTranscriptTail returns nulls for empty input', () => {
  assert.deepEqual(parseTranscriptTail(''),
    { lastTs: null, lastCwd: null, prLink: null, aiTitle: null });
});

// Real ai-title records carry no timestamp at all — this is the shape that
// actually ships, not a hypothetical.
test('parseTranscriptTail extracts aiTitle from a timestamp-less ai-title record', () => {
  const text = [
    JSON.stringify({ type: 'user', cwd: '/w', timestamp: '2026-07-28T13:00:00.000Z' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Review GitHub pull request 133 adversarially',
      sessionId: 'abc' }),
  ].join('\n');
  assert.equal(parseTranscriptTail(text).aiTitle,
    'Review GitHub pull request 133 adversarially');
});

test('parseTranscriptTail returns null aiTitle when the tail has no ai-title record', () => {
  const text = [
    JSON.stringify({ type: 'user', cwd: '/w', timestamp: '2026-07-28T13:00:00.000Z' }),
    JSON.stringify({ type: 'system', timestamp: '2026-07-28T13:01:00.000Z' }),
  ].join('\n');
  assert.equal(parseTranscriptTail(text).aiTitle, null);
});

test('parseTranscriptTail keeps the newest ai-title when several are present', () => {
  // Scanning backwards, the last one written (bottom of file) must win.
  const text = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Older title' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Newer title' }),
  ].join('\n');
  assert.equal(parseTranscriptTail(text).aiTitle, 'Newer title');
});

test('parseGithubSlug parses the SSH remote form', () => {
  assert.equal(parseGithubSlug('git@github.com:HumandDev/humand-web.git'),
    'HumandDev/humand-web');
});

test('parseGithubSlug parses the SSH remote form without .git', () => {
  assert.equal(parseGithubSlug('git@github.com:HumandDev/humand-web'),
    'HumandDev/humand-web');
});

test('parseGithubSlug parses the HTTPS remote form', () => {
  assert.equal(parseGithubSlug('https://github.com/HumandDev/humand-web.git'),
    'HumandDev/humand-web');
});

test('parseGithubSlug parses the HTTPS remote form without .git', () => {
  assert.equal(parseGithubSlug('https://github.com/HumandDev/humand-web'),
    'HumandDev/humand-web');
});

test('parseGithubSlug returns null for a non-GitHub host', () => {
  assert.equal(parseGithubSlug('git@gitlab.com:HumandDev/humand-web.git'), null);
  assert.equal(parseGithubSlug('https://gitlab.com/HumandDev/humand-web'), null);
});

test('parseGithubSlug returns null for an empty string', () => {
  assert.equal(parseGithubSlug(''), null);
});

test('parseGithubSlug returns null for garbage input', () => {
  assert.equal(parseGithubSlug('not a remote url at all'), null);
});

test('parseLastCommitLog splits epoch seconds and subject on the first NUL', () => {
  const out = parseLastCommitLog('1784830161\x00chore(test): instrument sources for E2E coverage');
  assert.equal(out.ts, 1784830161000);
  assert.equal(out.subject, 'chore(test): instrument sources for E2E coverage');
});

test('parseLastCommitLog keeps a subject containing a literal %', () => {
  const out = parseLastCommitLog('1700000000\x00fix: bump coverage to 100% on module');
  assert.equal(out.subject, 'fix: bump coverage to 100% on module');
});

test('parseLastCommitLog splits on the FIRST NUL only, tolerating one in the subject', () => {
  const out = parseLastCommitLog('1700000000\x00weird\x00subject');
  assert.equal(out.ts, 1700000000000);
  assert.equal(out.subject, 'weird\x00subject');
});

test('parseLastCommitLog returns a null subject when the subject is empty', () => {
  const out = parseLastCommitLog('1700000000\x00');
  assert.equal(out.ts, 1700000000000);
  assert.equal(out.subject, null);
});

test('parseLastCommitLog returns nulls for empty input', () => {
  const out = parseLastCommitLog('');
  assert.equal(out.ts, null);
  assert.equal(out.subject, null);
});

test('parseCommitRangeLog takes count and subject from the newest (first) line', () => {
  const out = parseCommitRangeLog(
    '1700000200\x00fix audience update (#11916)\n' +
    '1700000100\x00wip\n'
  );
  assert.equal(out.count, 2);
  assert.equal(out.subject, 'fix audience update (#11916)');
});

test('parseCommitRangeLog returns count 0 and a null subject for an empty range', () => {
  const out = parseCommitRangeLog('');
  assert.equal(out.count, 0);
  assert.equal(out.subject, null);
});

test('parseCommitRangeLog keeps a subject containing a literal %', () => {
  const out = parseCommitRangeLog('1700000000\x00fix: bump coverage to 100% on module\n');
  assert.equal(out.count, 1);
  assert.equal(out.subject, 'fix: bump coverage to 100% on module');
});

test('parseCommitRangeLog returns a null subject when the newest line has an empty subject', () => {
  const out = parseCommitRangeLog('1700000000\x00\n');
  assert.equal(out.count, 1);
  assert.equal(out.subject, null);
});

// safeHttpUrl is the scheme allowlist that keeps a `javascript:` URI (or any
// other non-http(s) scheme) out of every href derived from untrusted local
// data. It must accept only http/https and reject everything else, including
// scheme-confusion tricks a regex or startsWith denylist would miss.
test('safeHttpUrl accepts http and https URLs unchanged', () => {
  assert.equal(safeHttpUrl('http://example.com/x'), 'http://example.com/x');
  assert.equal(safeHttpUrl('https://github.com/HumandDev/humand-web/pull/1'),
    'https://github.com/HumandDev/humand-web/pull/1');
});

test('safeHttpUrl rejects a javascript: URI', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
});

test('safeHttpUrl rejects a javascript: URI regardless of case', () => {
  assert.equal(safeHttpUrl('JaVaScRiPt:alert(1)'), null);
});

test('safeHttpUrl rejects a javascript: URI with leading whitespace', () => {
  assert.equal(safeHttpUrl('  javascript:alert(1)'), null);
});

test('safeHttpUrl rejects a javascript: URI with an embedded tab in the scheme', () => {
  assert.equal(safeHttpUrl('java\tscript:alert(1)'), null);
});

test('safeHttpUrl rejects a data: URI', () => {
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
});

test('safeHttpUrl rejects a vbscript: URI', () => {
  assert.equal(safeHttpUrl('vbscript:msgbox(1)'), null);
});

test('safeHttpUrl rejects a file: URI', () => {
  assert.equal(safeHttpUrl('file:///etc/passwd'), null);
});

test('safeHttpUrl rejects a protocol-relative URL', () => {
  assert.equal(safeHttpUrl('//evil.com/x'), null);
});

test('safeHttpUrl rejects an empty string, null, undefined, and non-strings', () => {
  assert.equal(safeHttpUrl(''), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl(undefined), null);
  assert.equal(safeHttpUrl(42), null);
});

// The parsing boundary: a poisoned prUrl in a pr-link transcript record must
// never survive into the payload, but the number and repo — which carry no
// injection risk — must still come through untouched.
test('parseTranscriptTail nulls out a javascript: prUrl but keeps number and repo', () => {
  const text = JSON.stringify({ type: 'pr-link', sessionId: 's1', prNumber: 42,
    prUrl: 'javascript:alert(1)', prRepository: 'HumandDev/humand-web',
    timestamp: '2026-07-28T13:49:04.352Z' }) + '\n';
  const { prLink } = parseTranscriptTail(text);
  assert.equal(prLink.number, 42);
  assert.equal(prLink.repo, 'HumandDev/humand-web');
  assert.equal(prLink.url, null);
});

// The count alone cannot be acted on. Asked "1 file uncommitted, commit it?" the
// honest answer is "depends what it is" — and the motivating real case was a
// single modified file holding a `// TEMP — DO NOT COMMIT` flag override, where
// the count pointed at exactly the wrong answer.
test('parseStatusFiles returns status code and path per entry', () => {
  const out = parseStatusFiles(' M src/hooks/useCommunityFeature.ts\n?? node_modules\n');
  assert.deepEqual(out, [
    { code: 'M', path: 'src/hooks/useCommunityFeature.ts' },
    { code: '??', path: 'node_modules' },
  ]);
});

test('parseStatusFiles caps the sample and ignores blank lines', () => {
  const many = Array.from({ length: 9 }, (_, i) => ` M f${i}.ts`).join('\n') + '\n\n';
  assert.equal(parseStatusFiles(many).length, 5);
  assert.equal(parseStatusFiles(many, 2).length, 2);
  assert.deepEqual(parseStatusFiles(''), []);
});

// Renames arrive as `R  old -> new`; keeping the arrow intact is more useful than
// half-parsing it, and the code already says it is a rename.
test('parseStatusFiles keeps a rename readable', () => {
  assert.deepEqual(parseStatusFiles('R  a.ts -> b.ts\n'),
    [{ code: 'R', path: 'a.ts -> b.ts' }]);
});
