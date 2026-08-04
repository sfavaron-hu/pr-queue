# Work assistant — Increment 3: the file queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the gate's items as an append-only, crash-safe file protocol under `state/assist/` — content-addressed ids that dedup across passes, answers validated against the item's own options, and a `declined` decision that sticks — so a later executor and a later UI share one queue.

**Architecture:** A pure-ish `assist/queue.js` whose every filesystem touch goes through an injected `io` object (so the whole protocol is testable with an in-memory fake, and real `fs` lives only in the bin). Content-addressed ids (`sha256` of the item's stable identity, truncated) make writing idempotent: re-deriving the same item lands the same file, a genuinely changed situation lands a new one. Maildir-style delivery (`tmp/` → `rename()`) means nothing is ever read half-written. `syncItems` reconciles a gate pass into `items/`, suppressing anything `declined` and still within its TTL and clearing anything the situation resolved. Answers are validated against the item's declared options. A thin `assist/bin/queue.js` wires real `fs`, runs the live gate, syncs it, and lists the open queue.

**Tech Stack:** Node (no dependencies, `node --test`), `node:crypto` (built-in) for the id hash, the Increment 2 gate (`assist/gate.js`, `assist/bin/gate.js`) as the item source.

## Global Constraints

- **No dependencies, no build step.** `node --test` only. `node:crypto` is built-in and allowed.
- **`assist/queue.js` does NO direct filesystem access.** Every read/write/list/rename/delete goes through an injected `io` object (see its shape below). Real `fs` appears only in `assist/bin/queue.js`. This is what makes the protocol testable with an in-memory fake and keeps the module pure of IO.
- **`io` shape** (the contract every queue function takes): `{ read(path)->string, write(path, str), rename(from, to), remove(path), exists(path)->bool, list(dir)->[names], mkdirp(dir), now()->ms }`. A function that needs a timestamp takes it from `io.now()`, never `Date.now()` — so tests are deterministic.
- **Atomic delivery.** Every durable write is `write(tmpPath, contents)` then `rename(tmpPath, finalPath)` — never a direct write to the final path. A reader must never see a half-written file.
- **Content-addressed ids.** `itemId(item)` = first 16 hex chars of `sha256` over a canonical string of the item's *stable* identity (`type`, `processKey`, `key`). Re-deriving the same gate item yields the same id (dedup); a genuinely different situation yields a different `key` and therefore a different id (asks again). Do **not** fold volatile magnitude (a dirty-file count, a day count) into the id — that would defeat `declined` by re-asking on trivial drift. (A finer evidence fingerprint is a deliberate future refinement, noted, not built.)
- **`state/` is gitignored.** Add `state/` to `.gitignore`. The queue lives at `state/assist/{items,answers,done,declined}/`. `state/` deliberately holds no committed content — which is exactly why `done/` is *kept* rather than deleted (git is not the history here).
- **`declined` persists and suppresses.** A declined item carries `{ until }` (default TTL 30 days from `io.now()`). While `until > now`, `syncItems` must not re-write that item into `items/`. An expired `declined` stops suppressing and is prunable.
- **`done/` is retained, not deleted on completion.** It is the record of what the assistant did unattended (the digest). Pruned only past a 30-day retention.
- **Answers accept two shapes, and validation differs by caller.** `{ value }` must equal one of the item's declared option `label`s (read from `items/<id>.json`). `{ other: "<text>" }` is accepted **only** when the caller passes `allowOther: true` (the skill, because `AskUserQuestion` always offers "Other"); the future browser endpoint passes `allowOther: false` and may write `{ value }` only.
- **The queue does not execute anything and contains no model.** Acting on an answer, dispatching a subagent, and calling `AskUserQuestion` are Increment 4. This increment only maintains the files.
- **`assist/*` are Node CommonJS**; `const`/`let` fine. No hardcoded `/Users/...` — `tests/shareability.test.js`'s `CODE` list must gain `assist/queue.js` and `assist/bin/queue.js`.

---

## File Structure

- **Create `assist/queue.js`** — the protocol: `queuePaths`, `itemId`, `writeAtomic`, `syncItems`, `readItem`, `listOpenItems`, `writeAnswer`, `readAnswer`, `decline`, `isDeclined`, `markDone`, `pruneDone`, `pruneDeclined`. All take an injected `io`.
- **Create `assist/bin/queue.js`** — the real-`fs` `io` adapter, plus a `main()` that runs the live gate (via `assist/bin/gate.js`'s pieces), syncs items into `state/assist/`, prunes expiries, and prints the open queue. `module.exports = { main, fsIo, stateRoot }`.
- **Modify `.gitignore`** — add `state/`.
- **Modify `tests/shareability.test.js`** — add the two new files to `CODE`.
- **Create `tests/assist-queue-id.test.js`** — `itemId` determinism/divergence; `queuePaths`; `writeAtomic` (tmp→rename order).
- **Create `tests/assist-queue-sync.test.js`** — `syncItems` write/skip-declined/remove-stale; `decline`/`isDeclined`/`pruneDeclined`.
- **Create `tests/assist-queue-answers.test.js`** — `writeAnswer` validation (value∈options; other gated by `allowOther`); `readAnswer`.
- **Create `tests/assist-queue-lifecycle.test.js`** — `markDone` (move + retain); `listOpenItems`; `pruneDone`.

**The in-memory fake `io`** (used across the test files — each defines its own copy, since tests are independent):

```javascript
function memIo(nowMs) {
  const files = new Map();          // path -> string
  let clock = nowMs || 0;
  return {
    _files: files,
    _setNow: (t) => { clock = t; },
    now: () => clock,
    read: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    write: (p, s) => { files.set(p, s); },
    rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.set(b, files.get(a)); files.delete(a); },
    remove: (p) => { files.delete(p); },
    exists: (p) => files.has(p),
    list: (dir) => {
      const pre = dir.endsWith('/') ? dir : dir + '/';
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(pre)) names.add(k.slice(pre.length).split('/')[0]);
      return [...names];
    },
    mkdirp: () => {},               // directories are implicit in the map
  };
}
```

---

## Task 1: ids, paths, atomic write

The foundation every other task builds on: where files live, how an item becomes a stable id, and the tmp→rename write.

**Files:**
- Create: `assist/queue.js`
- Test: `tests/assist-queue-id.test.js`

**Interfaces:**
- Produces:
  - `queuePaths(root) -> { root, items, answers, done, declined, tmp }` — the six directory paths under `<root>/assist`.
  - `itemId(item) -> string` — 16-hex content address of `{type, processKey, key}`.
  - `writeAtomic(io, paths, finalPath, obj)` — JSON-stringify `obj`, write to a unique path in `tmp/`, then `rename` onto `finalPath`.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-queue-id.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, writeAtomic } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}

test('queuePaths lays out the six dirs under <root>/assist', () => {
  const p = queuePaths('/state');
  assert.equal(p.items, '/state/assist/items');
  assert.equal(p.answers, '/state/assist/answers');
  assert.equal(p.done, '/state/assist/done');
  assert.equal(p.declined, '/state/assist/declined');
  assert.equal(p.tmp, '/state/assist/tmp');
});

test('itemId is stable for the same item identity', () => {
  const a = { type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1', question: 'x?', options: [] };
  const b = { type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1', question: 'DIFFERENT COPY?', options: [{ label: 'z' }] };
  // Same identity (type+processKey+key) → same id even though question/options text differs.
  assert.equal(itemId(a), itemId(b));
  assert.match(itemId(a), /^[0-9a-f]{16}$/);
});

test('itemId diverges when the situation changes (different key)', () => {
  const cold = itemId({ type: 'question', processKey: 'SQSH-1', key: 'cold:SQSH-1' });
  const dirty = itemId({ type: 'question', processKey: 'SQSH-1', key: 'dirty:SQSH-1' });
  assert.notEqual(cold, dirty);
});

test('itemId does not fold volatile magnitude into the id', () => {
  // A dirty question with 3 files vs 5 files is the same decision — same id, so a
  // "leave it" keeps suppressing. The count lives in the item body, not the key.
  const three = itemId({ type: 'question', processKey: 'p', key: 'dirty:p' });
  const five  = itemId({ type: 'question', processKey: 'p', key: 'dirty:p' });
  assert.equal(three, five);
});

test('writeAtomic writes to tmp then renames onto the final path', () => {
  const io = memIo();
  const paths = queuePaths('/state');
  const order = [];
  const wrapped = Object.assign({}, io, {
    write: (p, s) => { order.push(['write', p]); io.write(p, s); },
    rename: (a, b) => { order.push(['rename', a, b]); io.rename(a, b); },
  });
  writeAtomic(wrapped, paths, `${paths.items}/abc.json`, { hello: 1 });
  // wrote to a tmp path first, then renamed onto the final path
  assert.equal(order[0][0], 'write');
  assert.match(order[0][1], /\/state\/assist\/tmp\//);
  assert.equal(order[1][0], 'rename');
  assert.equal(order[1][2], `${paths.items}/abc.json`);
  // final file exists and parses; no tmp left behind
  assert.deepEqual(JSON.parse(io.read(`${paths.items}/abc.json`)), { hello: 1 });
  assert.equal(io.list(paths.tmp).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-queue-id.test.js`
Expected: FAIL — cannot find `../assist/queue.js`.

- [ ] **Step 3: Implement the foundation in `assist/queue.js`**

```javascript
// The work assistant's file queue: an append-only, crash-safe protocol under
// state/assist/. Every filesystem touch goes through an injected `io` (see the
// plan's Global Constraints for its shape), so the whole protocol is testable
// with an in-memory fake and real fs lives only in assist/bin/queue.js. No
// model, no execution — this increment only maintains the files.
const crypto = require('node:crypto');

function queuePaths(root) {
  const base = `${root}/assist`;
  return {
    root: base,
    items: `${base}/items`,
    answers: `${base}/answers`,
    done: `${base}/done`,
    declined: `${base}/declined`,
    tmp: `${base}/tmp`,
  };
}

// Content address of an item's STABLE identity. The gate already emits a `key`
// that is stable per situation (`dirty:<pk>`, `cold:<pk>`, `babysit:comments`,
// `babysit:needs-human:<file>`); combined with type and processKey it uniquely
// and reproducibly names the decision. Volatile magnitude (counts, days) is
// deliberately excluded so a "leave it" keeps suppressing across trivial drift.
function itemId(item) {
  const canonical = `${item.type}|${item.processKey || ''}|${item.key || ''}`;
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Maildir-style delivery: write to a unique tmp path, then rename onto the final
// path. A reader of the final path never sees a partial file — rename is atomic
// within a filesystem. The tmp name carries the pid-free uniqueness we need via
// io.now() plus a random suffix.
function writeAtomic(io, paths, finalPath, obj) {
  io.mkdirp(paths.tmp);
  const rand = crypto.randomBytes(6).toString('hex');
  const tmpPath = `${paths.tmp}/${io.now()}-${rand}.json`;
  io.write(tmpPath, JSON.stringify(obj, null, 2));
  io.rename(tmpPath, finalPath);
}

module.exports = { queuePaths, itemId, writeAtomic };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/assist-queue-id.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 228 + 5 = **233**.

- [ ] **Step 6: Commit**

```bash
git add assist/queue.js tests/assist-queue-id.test.js
git commit -m "feat: queue foundation — content-addressed ids, paths, atomic write"
```

---

## Task 2: `syncItems` and the `declined` suppression

Reconcile a gate pass into `items/`: write the open ones, skip anything declined-and-unexpired, and clear anything the situation resolved.

**Files:**
- Modify: `assist/queue.js` (add `decline`, `isDeclined`, `pruneDeclined`, `syncItems`, `readItem`)
- Test: `tests/assist-queue-sync.test.js` (create)

**Interfaces:**
- Consumes: gate items `{ type, processKey, key, ... }`.
- Produces:
  - `decline(io, paths, id, ttlDays)` — write `declined/<id>.json = { until: io.now() + ttlDays*86400_000 }` atomically. `ttlDays` defaults to 30.
  - `isDeclined(io, paths, id) -> bool` — a declined file exists and its `until > io.now()`.
  - `pruneDeclined(io, paths) -> number` — remove expired declined files, return the count removed.
  - `readItem(io, paths, id) -> item | null`.
  - `syncItems(io, paths, items) -> { written:[id], skipped:[id], removed:[id] }` — write each incoming item to `items/<id>.json` unless `isDeclined`; then remove any `items/<id>.json` whose id is not in the incoming set AND has no pending `answers/<id>.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-queue-sync.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, decline, isDeclined, pruneDeclined, readItem } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}
const DAY = 86400000;
const q = (key, over) => Object.assign({ type: 'question', processKey: key.split(':')[1] || key, key }, over);

test('syncItems writes each open item to items/<id>.json', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const items = [q('dirty:a'), q('cold:b')];
  const res = syncItems(io, paths, items);
  assert.equal(res.written.length, 2);
  assert.deepEqual(readItem(io, paths, itemId(items[0])).key, 'dirty:a');
});

test('re-syncing the same items writes the same ids (idempotent dedup)', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const items = [q('dirty:a')];
  const first = syncItems(io, paths, items).written;
  const second = syncItems(io, paths, items).written;
  assert.deepEqual(first, second);
  assert.equal(io.list(paths.items).length, 1);
});

test('a declined-and-unexpired item is skipped, not written', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:a');
  decline(io, paths, itemId(item), 30);
  const res = syncItems(io, paths, [item]);
  assert.deepEqual(res.skipped, [itemId(item)]);
  assert.equal(io.exists(`${paths.items}/${itemId(item)}.json`), false);
});

test('an expired decline no longer suppresses', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:a');
  decline(io, paths, itemId(item), 30);
  io._setNow(1000 + 31 * DAY);
  const res = syncItems(io, paths, [item]);
  assert.deepEqual(res.written, [itemId(item)]);
});

test('isDeclined is true only while unexpired', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const id = itemId(q('cold:a'));
  decline(io, paths, id, 10);
  assert.equal(isDeclined(io, paths, id), true);
  io._setNow(1000 + 11 * DAY);
  assert.equal(isDeclined(io, paths, id), false);
});

test('pruneDeclined removes expired declines and counts them', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  decline(io, paths, 'aaa', 5);
  decline(io, paths, 'bbb', 40);
  io._setNow(1000 + 10 * DAY);
  assert.equal(pruneDeclined(io, paths), 1);       // only 'aaa' expired
  assert.equal(io.exists(`${paths.declined}/bbb.json`), true);
});

test('syncItems removes a stale item the gate no longer produces', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [q('dirty:a'), q('cold:b')]);
  const res = syncItems(io, paths, [q('dirty:a')]);   // cold:b resolved
  assert.deepEqual(res.removed, [itemId(q('cold:b'))]);
  assert.equal(io.exists(`${paths.items}/${itemId(q('cold:b'))}.json`), false);
});

test('syncItems does NOT remove a stale item that has a pending answer', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const item = q('cold:b');
  syncItems(io, paths, [item]);
  io.write(`${paths.answers}/${itemId(item)}.json`, JSON.stringify({ value: 'Dejar' }));
  const res = syncItems(io, paths, []);              // gate no longer emits it
  assert.equal(res.removed.includes(itemId(item)), false);
  assert.equal(io.exists(`${paths.items}/${itemId(item)}.json`), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-queue-sync.test.js`
Expected: FAIL — `syncItems`/`decline`/etc. not exported.

- [ ] **Step 3: Implement in `assist/queue.js`**

Add before `module.exports`, and extend the export:

```javascript
const DAY_MS = 86400000;

function declinedPath(paths, id) { return `${paths.declined}/${id}.json`; }
function itemPath(paths, id) { return `${paths.items}/${id}.json`; }
function answerPath(paths, id) { return `${paths.answers}/${id}.json`; }

function decline(io, paths, id, ttlDays) {
  const days = typeof ttlDays === 'number' ? ttlDays : 30;
  writeAtomic(io, paths, declinedPath(paths, id), { until: io.now() + days * DAY_MS });
}

function isDeclined(io, paths, id) {
  const p = declinedPath(paths, id);
  if (!io.exists(p)) return false;
  try {
    const rec = JSON.parse(io.read(p));
    return typeof rec.until === 'number' && rec.until > io.now();
  } catch { return false; }
}

function pruneDeclined(io, paths) {
  let removed = 0;
  for (const name of io.list(paths.declined)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const p = declinedPath(paths, id);
    let expired = true;
    try { const rec = JSON.parse(io.read(p)); expired = !(typeof rec.until === 'number' && rec.until > io.now()); }
    catch { expired = true; }
    if (expired) { io.remove(p); removed++; }
  }
  return removed;
}

function readItem(io, paths, id) {
  const p = itemPath(paths, id);
  if (!io.exists(p)) return null;
  try { return JSON.parse(io.read(p)); } catch { return null; }
}

// Reconcile a gate pass into items/. Write every incoming item (idempotent — the
// id is content-addressed) unless it is currently declined. Then remove any
// items/ file the gate no longer emits, EXCEPT one with a pending answer (the
// executor still owes it an action). Returns the three id lists for the caller
// to log.
function syncItems(io, paths, items) {
  io.mkdirp(paths.items);
  const written = [], skipped = [];
  const present = new Set();

  for (const item of items) {
    const id = itemId(item);
    present.add(id);
    if (isDeclined(io, paths, id)) { skipped.push(id); continue; }
    writeAtomic(io, paths, itemPath(paths, id), item);
    written.push(id);
  }

  const removed = [];
  for (const name of io.list(paths.items)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (present.has(id)) continue;
    if (io.exists(answerPath(paths, id))) continue;   // pending answer — keep
    io.remove(itemPath(paths, id));
    removed.push(id);
  }

  return { written, skipped, removed };
}
```

Extend the export:

```javascript
module.exports = { queuePaths, itemId, writeAtomic,
                   decline, isDeclined, pruneDeclined, readItem, syncItems };
```

- [ ] **Step 4: Run the sync tests**

Run: `node --test tests/assist-queue-sync.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 233 + 8 = **241**.

- [ ] **Step 6: Commit**

```bash
git add assist/queue.js tests/assist-queue-sync.test.js
git commit -m "feat: queue syncItems with declined suppression and stale cleanup"
```

---

## Task 3: answers, validated against the item's options

Record an owner's answer, but only a valid one: a `value` that matches one of the item's declared option labels, or free-text `other` when the caller allows it.

**Files:**
- Modify: `assist/queue.js` (add `writeAnswer`, `readAnswer`)
- Test: `tests/assist-queue-answers.test.js` (create)

**Interfaces:**
- Produces:
  - `writeAnswer(io, paths, id, answer, opts) -> { ok:true } | { ok:false, reason }` — validates `answer` and, if valid, writes `answers/<id>.json` atomically. `opts.allowOther` (default false) gates the `{ other }` shape. Validation reads `items/<id>.json` for the option labels; a missing item is `{ ok:false, reason:'no-item' }`.
  - `readAnswer(io, paths, id) -> answer | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-queue-answers.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, writeAnswer, readAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}

const item = { type: 'question', processKey: 'a', key: 'cold:a', question: '¿Qué hago?',
  options: [{ label: 'Retomar' }, { label: 'Dejar' }, { label: 'Archivar' }] };

function seed() { const io = memIo(1); const paths = queuePaths('/s'); syncItems(io, paths, [item]); return { io, paths, id: itemId(item) }; }

test('a value matching a declared option is accepted and stored', () => {
  const { io, paths, id } = seed();
  assert.deepEqual(writeAnswer(io, paths, id, { value: 'Dejar' }, {}), { ok: true });
  assert.deepEqual(readAnswer(io, paths, id), { value: 'Dejar' });
});

test('a value NOT among the options is rejected', () => {
  const { io, paths, id } = seed();
  const res = writeAnswer(io, paths, id, { value: 'Mergear' }, {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bad-value');
  assert.equal(io.exists(`${paths.answers}/${id}.json`), false);
});

test('an {other} free-text answer is rejected unless allowOther', () => {
  const { io, paths, id } = seed();
  assert.equal(writeAnswer(io, paths, id, { other: 'hacé X en vez' }, {}).ok, false);
  assert.equal(writeAnswer(io, paths, id, { other: 'hacé X en vez' }, { allowOther: true }).ok, true);
  assert.deepEqual(readAnswer(io, paths, id), { other: 'hacé X en vez' });
});

test('an answer to an unknown item is rejected', () => {
  const io = memIo(1); const paths = queuePaths('/s');
  assert.deepEqual(writeAnswer(io, paths, 'deadbeef', { value: 'x' }, {}), { ok: false, reason: 'no-item' });
});

test('an empty or malformed answer is rejected', () => {
  const { io, paths, id } = seed();
  assert.equal(writeAnswer(io, paths, id, {}, { allowOther: true }).ok, false);
  assert.equal(writeAnswer(io, paths, id, { other: '' }, { allowOther: true }).ok, false);
  assert.equal(writeAnswer(io, paths, id, { value: 42 }, {}).ok, false);
});

test('readAnswer returns null when none exists', () => {
  const { io, paths, id } = seed();
  assert.equal(readAnswer(io, paths, id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-queue-answers.test.js`
Expected: FAIL — `writeAnswer`/`readAnswer` not exported.

- [ ] **Step 3: Implement in `assist/queue.js`**

Add before `module.exports`, and extend the export:

```javascript
// Record an answer, but only a valid one. `{ value }` must equal one of the
// item's own option labels — the queue reads items/<id>.json for them, so the
// browser endpoint can never smuggle a value the question didn't offer.
// `{ other: text }` is free text a model will interpret, and is accepted only
// when the caller (the skill, never the browser) passes allowOther.
function writeAnswer(io, paths, id, answer, opts) {
  const item = readItem(io, paths, id);
  if (!item) return { ok: false, reason: 'no-item' };
  const allowOther = !!(opts && opts.allowOther);

  if (answer && typeof answer.value === 'string') {
    const labels = (item.options || []).map(o => o.label);
    if (labels.indexOf(answer.value) === -1) return { ok: false, reason: 'bad-value' };
    writeAtomic(io, paths, answerPath(paths, id), { value: answer.value });
    return { ok: true };
  }

  if (answer && typeof answer.other === 'string') {
    if (!allowOther) return { ok: false, reason: 'other-not-allowed' };
    if (answer.other.trim() === '') return { ok: false, reason: 'empty-other' };
    writeAtomic(io, paths, answerPath(paths, id), { other: answer.other });
    return { ok: true };
  }

  return { ok: false, reason: 'malformed' };
}

function readAnswer(io, paths, id) {
  const p = answerPath(paths, id);
  if (!io.exists(p)) return null;
  try { return JSON.parse(io.read(p)); } catch { return null; }
}
```

Extend the export to add `writeAnswer, readAnswer`.

- [ ] **Step 4: Run the answers tests**

Run: `node --test tests/assist-queue-answers.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 241 + 6 = **247**.

- [ ] **Step 6: Commit**

```bash
git add assist/queue.js tests/assist-queue-answers.test.js
git commit -m "feat: queue writeAnswer validated against the item's own options"
```

---

## Task 4: lifecycle — `markDone`, `listOpenItems`, `pruneDone`

Close the loop: move a handled item into the retained `done/` record, list what is still open (and how it was answered), and prune the record past retention.

**Files:**
- Modify: `assist/queue.js` (add `markDone`, `listOpenItems`, `pruneDone`)
- Test: `tests/assist-queue-lifecycle.test.js` (create)

**Interfaces:**
- Produces:
  - `markDone(io, paths, id, record)` — write `done/<id>.json = { doneAt: io.now(), ...record }` atomically, then remove `items/<id>.json` and `answers/<id>.json`. (The item's own content should be included by the caller via `record` — typically the item plus the answer plus what the executor did.)
  - `listOpenItems(io, paths) -> [ { id, item, answer } ]` — every `items/<id>.json` with its `answers/<id>.json` (or `null`), so a caller can tell answered-pending from unanswered.
  - `pruneDone(io, paths, retentionDays) -> number` — remove `done/<id>.json` whose `doneAt` is older than `retentionDays` (default 30), returning the count.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-queue-lifecycle.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { queuePaths, itemId, syncItems, writeAnswer, markDone, listOpenItems, pruneDone } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t)=>{clock=t;}, now: ()=>clock,
    read: (p)=>{ if(!files.has(p)) throw new Error('ENOENT '+p); return files.get(p); },
    write: (p,s)=>{ files.set(p,s); }, rename: (a,b)=>{ if(!files.has(a)) throw new Error('ENOENT '+a); files.set(b,files.get(a)); files.delete(a); },
    remove: (p)=>{ files.delete(p); }, exists: (p)=>files.has(p),
    list: (dir)=>{ const pre=dir.endsWith('/')?dir:dir+'/'; const n=new Set(); for(const k of files.keys()) if(k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: ()=>{} };
}
const DAY = 86400000;
const item = (key) => ({ type: 'question', processKey: key.split(':')[1], key, options: [{ label: 'Dejar' }] });

test('markDone moves the item into done/ and clears items/ + answers/', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const it = item('cold:a'); const id = itemId(it);
  syncItems(io, paths, [it]);
  writeAnswer(io, paths, id, { value: 'Dejar' }, {});
  markDone(io, paths, id, { item: it, answer: { value: 'Dejar' }, action: 'archived' });
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);
  assert.equal(io.exists(`${paths.answers}/${id}.json`), false);
  const rec = JSON.parse(io.read(`${paths.done}/${id}.json`));
  assert.equal(rec.action, 'archived');
  assert.equal(rec.doneAt, 1000);
});

test('listOpenItems pairs each open item with its answer (or null)', () => {
  const io = memIo(1); const paths = queuePaths('/s');
  const a = item('cold:a'), b = item('dirty:b');
  syncItems(io, paths, [a, b]);
  writeAnswer(io, paths, itemId(a), { value: 'Dejar' }, {});
  const open = listOpenItems(io, paths).sort((x, y) => x.item.key.localeCompare(y.item.key));
  assert.equal(open.length, 2);
  const byKey = Object.fromEntries(open.map(o => [o.item.key, o]));
  assert.deepEqual(byKey['cold:a'].answer, { value: 'Dejar' });
  assert.equal(byKey['dirty:b'].answer, null);
});

test('pruneDone removes records past retention and keeps recent ones', () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  const a = item('cold:a'), b = item('cold:b');
  syncItems(io, paths, [a, b]);
  markDone(io, paths, itemId(a), { item: a });    // doneAt 1000
  io._setNow(1000 + 20 * DAY);
  markDone(io, paths, itemId(b), { item: b });    // doneAt 1000+20d
  io._setNow(1000 + 40 * DAY);
  assert.equal(pruneDone(io, paths, 30), 1);      // only 'a' (40d old) pruned
  assert.equal(io.exists(`${paths.done}/${itemId(b)}.json`), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-queue-lifecycle.test.js`
Expected: FAIL — `markDone`/`listOpenItems`/`pruneDone` not exported.

- [ ] **Step 3: Implement in `assist/queue.js`**

Add before `module.exports`, and extend the export:

```javascript
function donePath(paths, id) { return `${paths.done}/${id}.json`; }

// The item is handled: record what happened (retained in done/ as the digest of
// unattended work) and clear it out of items/ and answers/. The caller supplies
// `record` — typically the item, the answer, and what the executor did.
function markDone(io, paths, id, record) {
  writeAtomic(io, paths, donePath(paths, id), Object.assign({ doneAt: io.now() }, record));
  io.remove(itemPath(paths, id));
  io.remove(answerPath(paths, id));
}

// Every open item paired with its answer (or null), so a caller can tell an
// answered-but-not-yet-executed item from one still awaiting the owner.
function listOpenItems(io, paths) {
  const out = [];
  for (const name of io.list(paths.items)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const item = readItem(io, paths, id);
    if (!item) continue;
    out.push({ id, item, answer: readAnswer(io, paths, id) });
  }
  return out;
}

// Keep the unattended-work record bounded: drop done/ entries older than the
// retention window (default 30 days).
function pruneDone(io, paths, retentionDays) {
  const days = typeof retentionDays === 'number' ? retentionDays : 30;
  const cutoff = io.now() - days * DAY_MS;
  let removed = 0;
  for (const name of io.list(paths.done)) {
    if (!name.endsWith('.json')) continue;
    let doneAt = 0;
    try { doneAt = JSON.parse(io.read(donePath(paths, name.slice(0, -5)))).doneAt || 0; } catch { doneAt = 0; }
    if (doneAt < cutoff) { io.remove(donePath(paths, name.slice(0, -5))); removed++; }
  }
  return removed;
}
```

Extend the export to add `markDone, listOpenItems, pruneDone`.

- [ ] **Step 4: Run the lifecycle tests**

Run: `node --test tests/assist-queue-lifecycle.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 247 + 3 = **250**.

- [ ] **Step 6: Commit**

```bash
git add assist/queue.js tests/assist-queue-lifecycle.test.js
git commit -m "feat: queue lifecycle — markDone, listOpenItems, pruneDone"
```

---

## Task 5: `assist/bin/queue.js` — real fs, live sync, gitignore, shareability

Wire the real filesystem, sync the live gate into `state/assist/`, prune expiries, print the open queue, and guard the new files.

**Files:**
- Create: `assist/bin/queue.js`
- Modify: `.gitignore` (add `state/`)
- Modify: `tests/shareability.test.js` (add `assist/queue.js`, `assist/bin/queue.js` to `CODE`)
- Test: `tests/assist-queue-lifecycle.test.js` (append the bin smoke test)

**Interfaces:**
- Consumes: the queue module; the gate pieces from `assist/bin/gate.js` (`babysitStateDir`) and the ledger/gate builders; `bin/collect.js` IO helpers.
- Produces: `main()` that builds the live gate, `syncItems`, prunes, prints the open queue, returns 0; `module.exports = { main, fsIo, stateRoot }`.

- [ ] **Step 1: Write the failing smoke test**

Append to `tests/assist-queue-lifecycle.test.js`:

```javascript
test('the bin module exposes main, fsIo and stateRoot, and does not run on require', () => {
  const mod = require('../assist/bin/queue.js');
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.stateRoot, 'function');
  // stateRoot derives from the checkout dir, never a hardcoded path
  assert.match(mod.stateRoot('/repo'), /^\/repo\/state$/);
  // fsIo is the real-fs adapter with the injected-io shape
  ['read', 'write', 'rename', 'remove', 'exists', 'list', 'mkdirp', 'now'].forEach(k =>
    assert.equal(typeof mod.fsIo[k], 'function', `fsIo.${k}`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-queue-lifecycle.test.js`
Expected: FAIL — cannot find `../assist/bin/queue.js`.

- [ ] **Step 3: Implement `assist/bin/queue.js`**

```javascript
#!/usr/bin/env node
// Real-fs wrapper around the queue. Runs the live gate, syncs its items into
// state/assist/, prunes expired declines and old done records, and prints the
// open queue. Reuses assist/bin/gate.js's ledger+gate wiring and bin/collect's
// IO helpers — no path or fetch logic is duplicated. state/ is gitignored.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate } = require('../gate.js');
const { babysitStateDir } = require('./gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');
const {
  queuePaths, syncItems, pruneDeclined, pruneDone, listOpenItems,
} = require('../queue.js');

// The queue lives beside the checkout, under a gitignored state/ dir. Derived
// from the checkout path, never hardcoded.
function stateRoot(checkoutDir) { return path.join(checkoutDir, 'state'); }

// The injected-io shape backed by the real filesystem. Directory reads tolerate
// a not-yet-created dir (empty list); everything else is a thin fs pass-through.
const fsIo = {
  now: () => Date.now(),
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, s) => fs.writeFileSync(p, s),
  rename: (a, b) => fs.renameSync(a, b),
  remove: (p) => { try { fs.unlinkSync(p); } catch { /* already gone */ } },
  exists: (p) => fs.existsSync(p),
  list: (dir) => { try { return fs.readdirSync(dir); } catch { return []; } },
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
};

async function main() {
  const checkoutDir = path.resolve(__dirname, '..', '..');
  const doc = await ledger({
    collect, fetchOwnPRs,
    ioForCollect: {
      env: process.env, homeDir: os.homedir(), checkoutDir,
      run, listDirs, listFiles, readTail, now: () => Date.now(),
    },
    run, now: () => Date.now(),
  });
  const gate = buildGate(doc, Date.now(), {
    babysitDir: babysitStateDir(process.env, os.homedir()), io: {
      exists: fsIo.exists, readText: fsIo.read, listFiles: (d) => fsIo.list(d),
    },
  });

  const paths = queuePaths(stateRoot(checkoutDir));
  // Ensure the four dirs exist before syncing.
  [paths.items, paths.answers, paths.done, paths.declined, paths.tmp].forEach(fsIo.mkdirp);

  const res = syncItems(fsIo, paths, gate.questions);   // notify items are not queued decisions
  const declinedPruned = pruneDeclined(fsIo, paths);
  const donePruned = pruneDone(fsIo, paths, 30);
  const open = listOpenItems(fsIo, paths);

  process.stdout.write(JSON.stringify({
    written: res.written.length, skipped: res.skipped.length, removed: res.removed.length,
    declinedPruned, donePruned,
    open: open.map(o => ({ id: o.id, key: o.item.key, answered: o.answer !== null })),
  }, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main, fsIo, stateRoot };
```

- [ ] **Step 4: Add `state/` to `.gitignore`**

`.gitignore` currently contains `.superpowers/`. Add a line:

```
state/
```

- [ ] **Step 5: Add the new files to the shareability guard**

In `tests/shareability.test.js`, append to `CODE`:

```javascript
              'assist/queue.js', 'assist/bin/queue.js',
```

- [ ] **Step 6: Run the unit tests**

Run: `node --test tests/assist-queue-lifecycle.test.js tests/shareability.test.js`
Expected: PASS — 4 lifecycle tests (3 + smoke) and the shareability scan (the new files use `path.resolve`/`os`, no hardcoded paths).

- [ ] **Step 7: Live verification against the real machine**

Run:
```bash
node assist/bin/queue.js > /tmp/queue.json; echo "exit: $?"
cat /tmp/queue.json
echo "--- files on disk ---"
find state/assist -type f | sort
echo "--- second run is idempotent (same open set, no dup) ---"
node assist/bin/queue.js | node -e "const j=JSON.parse(require('fs').readFileSync(0)); console.log('open:', j.open.length, '| written:', j.written, '| removed:', j.removed)"
```

Expected: exit 0; the first run prints `written` = the gate's current question count (≤4) and lists `open` with their `key`s; `state/assist/items/` holds one file per open question; the second run shows the same `open` count with `written` again (idempotent — same ids) and does not duplicate files. Record the verbatim output in your report. Confirm `git status` shows `state/` is NOT tracked (gitignored).

- [ ] **Step 8: Full suite**

Run: `npm test`
Expected: PASS, total = 250 + 1 = **251**.

- [ ] **Step 9: Commit**

```bash
git add assist/bin/queue.js .gitignore tests/shareability.test.js tests/assist-queue-lifecycle.test.js
git commit -m "feat: assist/bin/queue.js — sync the live gate into state/assist, gitignored"
```

---

## Self-Review notes

- **Spec coverage (§3):** the four dirs + Maildir tmp→rename → Task 1 (`queuePaths`, `writeAtomic`); content-addressed ids that dedup and re-ask on genuine change → Task 1 (`itemId`); `declined` persistence with TTL suppression → Task 2 (`decline`/`isDeclined`/`syncItems` skip); `done/` retained not deleted → Task 4 (`markDone`/`pruneDone`); the two answer shapes with `allowOther` gating → Task 3 (`writeAnswer`); the whole thing gitignored and wired to real fs → Task 5.
- **Divergence from the spec's literal id formula, documented:** the spec writes `sha256(type + processKey + subjectKind + evidenceFingerprint)`. The gate's `key` already encodes `subjectKind`+`processKey` stably, so the id is over `{type, processKey, key}`. A separate *volatile* evidenceFingerprint is deliberately excluded — folding a dirty-count or day-count into the id would make a "leave it" stop suppressing on trivial drift, defeating `declined`. A finer, stable evidence fingerprint is a future refinement with no consumer yet (YAGNI). Called out in `itemId` and here.
- **YAGNI/deferred:** executing an answer, dispatching a subagent, calling `AskUserQuestion`, the `POST /api/answer` endpoint (§6), and any heartbeat wiring are Increment 4 — this increment only maintains files. `notify` items are intentionally not queued as decisions (they need no answer); only `gate.questions` are synced.
- **Crash-safety** is structural, not asserted by hope: every durable write is tmp→rename (Task 1, used everywhere), so a reader never sees a partial file, and the in-memory fake models rename as delete-old/set-new so the tests exercise the same sequencing.
- **Type consistency:** every queue function is `(io, paths, ...)`; `io` is the documented 8-method shape; `paths` is `queuePaths(root)`'s object. `writeAnswer(io, paths, id, answer, opts)->{ok, reason?}`, `syncItems(...)->{written,skipped,removed}`, `listOpenItems(...)->[{id,item,answer}]`, `markDone(io,paths,id,record)`. The bin's `fsIo` implements all 8 methods (asserted by the smoke test).
- **Test-count arithmetic** (233/241/247/250/251) is a guide; the binding check is a green `npm test` per task.
