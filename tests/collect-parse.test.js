const { test } = require('node:test');
const assert = require('node:assert');
const { parseWorktrees, parseStatusShort, parseAgents,
        parseTranscriptTail } = require('../collect-parse.js');

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

test('parseStatusShort counts changed files', () => {
  assert.equal(parseStatusShort('?? AGENTS.md\n M src/a.ts\n M src/b.ts\n'), 3);
});

test('parseStatusShort returns 0 for a clean tree', () => {
  assert.equal(parseStatusShort(''), 0);
  assert.equal(parseStatusShort('\n'), 0);
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
  assert.deepEqual(parseTranscriptTail(''), { lastTs: null, lastCwd: null, prLink: null });
});
