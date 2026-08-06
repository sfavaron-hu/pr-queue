const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODE = ['classify.js', 'collect.js', 'collect-parse.js', 'collect-paths.js',
              'serve.js', 'local.js', 'bin/collect.js', 'scripts/install-launchd.sh'];

test('no committed code contains a hardcoded home directory', () => {
  for (const f of CODE) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    assert.ok(!/\/Users\/[a-z]/i.test(src), `${f} contains a hardcoded /Users path`);
    assert.ok(!/\/home\/[a-z]/i.test(src), `${f} contains a hardcoded /home path`);
  }
});

test('the launchd installer derives its paths instead of baking them in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-launchd.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /\$HOME/);
});

test('the README documents the localStorage gotcha and both env vars', () => {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(src, /PRQ_WORKSPACE/);
  assert.match(src, /PRQ_PORT/);
  assert.match(src, /localStorage/);
});

// `/search/issues` returns issue-shaped items with no head ref, so a merged PR
// arrives without the one field the join needs to attach it to its local
// worktree. The fallback — matching a ticket parsed out of the title — silently
// fails for no-ticket work: measured 3 of 7 merged PRs in the panel's window had
// no ticket anywhere in the title. These are source-level assertions because the
// browser files are plain globals with no module boundary to test through.
test('merged PRs are enriched with a head ref before reaching the join', () => {
  const gh = fs.readFileSync(path.join(ROOT, 'github.js'), 'utf8');
  assert.match(gh, /function fetchHeadRef/);
  assert.match(gh, /head && \w+\.head\.ref/);          // reads it off the pulls API
  assert.match(gh, /catch \{ return null; \}/);        // a failed GET must not drop the PR

  const render = fs.readFileSync(path.join(ROOT, 'render.js'), 'utf8');
  // mergedPRs must carry headRef, sourced from the search item's pulls URL.
  assert.match(render, /headRef: await fetchHeadRef\(pr\.pull_request/);
  // And it must be batched like the open-PR loop, not fired all at once.
  assert.match(render, /i \+= 4/);
});

// owner/repo#number is the only always-present, always-unique key. Falling
// through to a null headRef would collapse every ticket-less merged PR onto one
// shared process, which is the bug the fallback order exists to prevent.
test('the synthetic-process key falls back to owner/repo#number, not to headRef', () => {
  const local = fs.readFileSync(path.join(ROOT, 'local.js'), 'utf8');
  assert.match(local, /ticket \|\| pr\.headRef \|\| `\$\{pr\.owner\}\/\$\{pr\.repo\}#\$\{pr\.number\}`/);
});
