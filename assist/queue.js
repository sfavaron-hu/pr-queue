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
