const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// A hand-maintained list drifts the moment someone adds a file and forgets to
// list it — which is exactly what happened here (app.js, render.js, state.js,
// github.js, score.js and assist/flags.js all shipped unscanned). Walking the
// tree instead means the next new .js file is in scope by construction.
// `tests/` is excluded on purpose: its fixtures legitimately contain
// `/home/x`-shaped strings that would fail the very check this list feeds.
function walkJsFiles(dir, rel) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') return [];
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) return walkJsFiles(path.join(dir, e.name), relPath);
    return e.name.endsWith('.js') ? [relPath] : [];
  });
}

// The installer shell scripts aren't `.js` and so fall outside the walk
// above, but the hardcoded-home check below applies to them just as much —
// listed explicitly since scripts/ only ever grows by an explicit new file.
const SCRIPTS = ['scripts/install-launchd.sh', 'scripts/install-skill.sh', 'scripts/install-heartbeat-check.sh'];

const CODE = walkJsFiles(ROOT, '').concat(SCRIPTS);

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

test('the skill installer derives its paths and prints an uninstall', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-skill.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /CLAUDE_CONFIG_DIR/);
  assert.match(src, /[Uu]ninstall/);
});

test('the heartbeat-check installer derives its paths and prints an uninstall', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-heartbeat-check.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /CLAUDE_CONFIG_DIR/);
  assert.match(src, /run\.js/);            // the gate execs the executor
  assert.match(src, /[Uu]ninstall/);
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
