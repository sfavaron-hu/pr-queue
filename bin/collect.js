#!/usr/bin/env node
// Real-IO wrapper around collect(). Prints the payload to stdout.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../collect.js');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

async function listDirs(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const checks = await Promise.all(dirs.map(async d => {
    // .git is a file, not a directory, inside a linked worktree — stat, not isDirectory.
    try { await fs.stat(path.join(root, d, '.git')); return d; } catch { return null; }
  }));
  return checks.filter(Boolean);
}

async function listFiles(dir) {
  return fs.readdir(dir);
}

// Reads only the last `bytes` of a file. Transcripts run to thousands of
// records; we only need the tail to find the last real timestamp.
async function readTail(file, bytes) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length === 0) return '';
    await handle.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const payload = await collect({
    env: process.env,
    homeDir: os.homedir(),
    checkoutDir: path.resolve(__dirname, '..'),
    run, listDirs, listFiles, readTail,
    now: () => Date.now(),
  });
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run, listDirs, listFiles, readTail };
