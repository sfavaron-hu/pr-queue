const { test } = require('node:test');
const assert = require('node:assert');
const { stitchMission } = require('../mission.js');

const row = (key, worktrees) => ({ proc: { key: key, worktrees: worktrees || [] } });
const ask = (id, processKey) => ({ id: id, source: 'work', priority: 20,
  item: { type: 'question', key: 'dirty:' + processKey, processKey: processKey, question: '¿Qué hago?', header: 'Sin commit', options: [] } });

test('una pregunta se cose al proceso cuyo key matchea', () => {
  const out = stitchMission({ ask: [ask('a1', 'SQSH-4167')], leases: { active: [] } }, [row('SQSH-4167')]);
  assert.equal(out.perKey['SQSH-4167'].questions.length, 1);
  assert.deepEqual(out.matchedAskIds, ['a1']);
});

test('una pregunta con processKey desconocido no se cose y no se pierde', () => {
  const out = stitchMission({ ask: [ask('a1', 'SQSH-9999')], leases: { active: [] } }, [row('SQSH-4167')]);
  assert.equal(Object.keys(out.perKey).length, 0);
  assert.deepEqual(out.matchedAskIds, []);   // Task 2 le da card propia
});

test('un lease matchea por path', () => {
  const out = stitchMission({ ask: [], leases: { active: [{ path: '/w/a', branch: null, forWhat: 'e2e', minutesLeft: 32 }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'].lease.minutesLeft, 32);
});

test('un lease matchea por branch cuando el path no coincide', () => {
  const out = stitchMission({ ask: [], leases: { active: [{ path: '/otro', branch: 'feat/x', forWhat: 'e2e', minutesLeft: 5 }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'].lease.forWhat, 'e2e');
});

test('un lease vencido no cose nada', () => {
  const out = stitchMission({ ask: [], leases: { active: [], expired: [{ path: '/w/a', branch: 'feat/x' }] } },
                            [row('SQSH-4167', [{ path: '/w/a', branch: 'feat/x' }])]);
  assert.equal(out.perKey['SQSH-4167'], undefined);
});

test('sin payload no explota', () => {
  assert.deepEqual(stitchMission(null, [row('X')]), { perKey: {}, matchedAskIds: [] });
});
