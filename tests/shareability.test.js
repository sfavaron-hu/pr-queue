const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODE = ['classify.js', 'collect.js', 'collect-parse.js', 'collect-paths.js',
              'serve.js', 'local.js', 'bin/collect.js', 'scripts/install-launchd.sh',
              'assist/prs.js', 'assist/ledger.js', 'assist/bin/ledger.js',
              'assist/gate.js', 'assist/bin/gate.js'];

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

// A raw NUL byte anywhere in a source file makes git classify it as binary, and
// every later merge of that file degrades to an unresolvable whole-file conflict
// — which in a stacked branch series means the stack simply cannot be merged
// down. This happened once, in assist/ledger.js, where a NUL separator meant as
// a source escape was written as a literal byte. Escapes are fine; bytes are not.
test('no committed source file contains a raw NUL byte', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'state') return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|json|md|sh|html|css)$/.test(e.name) ? [full] : [];
  });
  for (const full of walk(ROOT)) {
    assert.ok(!fs.readFileSync(full).includes(0),
      `${path.relative(ROOT, full)} contains a raw NUL byte — write it as an escape`);
  }
});
