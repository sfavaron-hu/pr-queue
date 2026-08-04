// tests/assist-executor-actions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { runAction, drainActions } = require('../assist/executor.js');

// A recording exec: captures every argv array it is handed, returns a scripted result.
function fakeExec(script) {
  const calls = [];
  const exec = (argv) => { calls.push(argv); return (script && script(argv)) || { code: 0, stdout: '', stderr: '' }; };
  exec.calls = calls;
  return exec;
}
// Action fixture: cmd carries a shell-injection payload that argv does NOT.
const action = (over) => Object.assign({
  id: 'push:p1:r:b', kind: 'push', processKey: 'p1', repo: 'r',
  cmd: 'git -C /w/r push -u origin b; rm -rf $HOME',
  argv: ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b'],
}, over);

test('runAction executes action.argv verbatim and never touches action.cmd', () => {
  const exec = fakeExec();
  runAction(exec, action());
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0], ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']);
  // The injection payload from cmd never reaches exec, in any argument, in any form.
  const flat = exec.calls[0].join(' ');
  assert.ok(!flat.includes('rm -rf'), 'cmd payload must not reach exec');
});

test('runAction reports ok:true on exit 0, ok:false on non-zero', () => {
  assert.equal(runAction(fakeExec(() => ({ code: 0, stdout: 'ok', stderr: '' })), action()).ok, true);
  const bad = runAction(fakeExec(() => ({ code: 1, stdout: '', stderr: 'boom' })), action());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, 'boom');
});

test('runAction refuses an action with no argv (never falls back to cmd)', () => {
  const exec = fakeExec();
  const r = runAction(exec, action({ argv: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-argv');
  assert.equal(exec.calls.length, 0);   // nothing executed
});

test('runAction refuses a non-string-array argv', () => {
  const exec = fakeExec();
  assert.equal(runAction(exec, action({ argv: [] })).error, 'no-argv');
  assert.equal(runAction(exec, action({ argv: ['git', 42] })).error, 'no-argv');
  assert.equal(exec.calls.length, 0);
});

test('drainActions runs every action and continues past a failure', () => {
  const exec = fakeExec((argv) => ({ code: argv.includes('bad') ? 1 : 0, stdout: '', stderr: '' }));
  const res = drainActions(exec, [
    action({ id: 'a', argv: ['git', 'ok'] }),
    action({ id: 'b', argv: ['git', 'bad'] }),
    action({ id: 'c', argv: ['git', 'ok'] }),
  ]);
  assert.equal(res.ran, 3);
  assert.equal(res.failed, 1);
  assert.equal(res.results.length, 3);
  assert.equal(res.results.find(r => r.id === 'b').ok, false);
});
