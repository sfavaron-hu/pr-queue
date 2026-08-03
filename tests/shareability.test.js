const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODE = ['classify.js', 'collect.js', 'collect-parse.js', 'collect-paths.js',
              'serve.js', 'local.js', 'bin/collect.js', 'scripts/install-launchd.sh',
              'assist/prs.js', 'assist/ledger.js', 'assist/bin/ledger.js'];

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
