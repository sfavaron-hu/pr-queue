const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listDirs } = require('../bin/collect.js');

// `.git` is a directory only in a main checkout; in a linked worktree it's a
// file. listDirs must only surface main checkouts, or a linked worktree gets
// rediscovered as its own "repo" and its `git worktree list` re-reports the
// whole set again (this is exactly the bug that produced duplicate worktree
// rows in the payload).
test('listDirs returns only dirs whose .git is a directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prq-listdirs-'));
  try {
    await fs.mkdir(path.join(root, 'main-checkout', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'linked-worktree'), { recursive: true });
    await fs.writeFile(path.join(root, 'linked-worktree', '.git'), 'gitdir: /elsewhere/.git\n');
    await fs.mkdir(path.join(root, 'not-a-repo'), { recursive: true });

    const dirs = await listDirs(root);
    assert.deepEqual(dirs.sort(), ['main-checkout']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
