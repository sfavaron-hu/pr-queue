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

module.exports = { queuePaths, itemId, writeAtomic,
                   decline, isDeclined, pruneDeclined, readItem, syncItems,
                   writeAnswer, readAnswer };
