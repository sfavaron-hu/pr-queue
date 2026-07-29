const { test } = require('node:test');
const assert = require('node:assert');
const { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch } = require('../collect-paths.js');

test('PRQ_WORKSPACE wins when set', () => {
  assert.equal(resolveWorkspaceRoot({ PRQ_WORKSPACE: '/custom/ws' }, '/anything/pr-queue'), '/custom/ws');
});

test('workspace root defaults to the parent of the checkout', () => {
  assert.equal(resolveWorkspaceRoot({}, '/home/dev/repos/pr-queue'), '/home/dev/repos');
});

test('an empty PRQ_WORKSPACE is ignored', () => {
  assert.equal(resolveWorkspaceRoot({ PRQ_WORKSPACE: '' }, '/home/dev/repos/pr-queue'), '/home/dev/repos');
});

test('CLAUDE_CONFIG_DIR wins over the home default', () => {
  assert.equal(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/cfg/claude' }, '/home/dev'), '/cfg/claude');
});

test('claude dir defaults to ~/.claude', () => {
  assert.equal(resolveClaudeDir({}, '/home/dev'), '/home/dev/.claude');
});

test('pickBaseBranch prefers origin/HEAD when present', () => {
  // 'trunk' is deliberately absent from BASE_FALLBACKS and the fallback list is
  // empty, so this can only pass via the primary regex — not via the fallback
  // returning the same string by coincidence.
  assert.equal(pickBaseBranch('refs/remotes/origin/trunk', []), 'trunk');
});

test('pickBaseBranch falls through to the fallback list when the primary ref is malformed', () => {
  assert.equal(pickBaseBranch('not-a-ref', ['develop']), 'develop');
});

test('pickBaseBranch falls back to develop, then main, then master', () => {
  assert.equal(pickBaseBranch(null, ['main', 'develop', 'master']), 'develop');
  assert.equal(pickBaseBranch(null, ['main', 'master']), 'main');
  assert.equal(pickBaseBranch(null, ['master']), 'master');
});

test('pickBaseBranch returns null rather than guessing', () => {
  assert.equal(pickBaseBranch(null, []), null);
  assert.equal(pickBaseBranch(null, ['trunk', 'release']), null);
});

test('pickBaseBranch handles the trailing newline that real git output carries', () => {
  // Empty fallback lists are deliberate: passing the same branch name in
  // remoteBranches would let the fallback path mask a broken primary match,
  // since both would return the same value either way.
  assert.equal(pickBaseBranch('refs/remotes/origin/develop\n', []), 'develop');
  assert.equal(pickBaseBranch('  refs/remotes/origin/main  \n', []), 'main');
});
