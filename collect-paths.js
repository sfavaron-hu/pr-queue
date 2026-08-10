// Pure resolution of workspace/config locations and base branch.
// No hardcoded absolute paths: everything derives from env or arguments.
const path = require('node:path');

function resolveWorkspaceRoot(env, checkoutDir) {
  const explicit = env && env.PRQ_WORKSPACE;
  if (explicit && String(explicit).trim() !== '') return explicit;
  // pr-queue is expected to sit alongside the repos it reports on.
  return path.dirname(checkoutDir);
}

function resolveClaudeDir(env, homeDir) {
  const explicit = env && env.CLAUDE_CONFIG_DIR;
  if (explicit && String(explicit).trim() !== '') return explicit;
  return path.join(homeDir, '.claude');
}

const BASE_FALLBACKS = ['develop', 'main', 'master'];

function pickBaseBranch(originHeadRef, remoteBranches) {
  if (originHeadRef) {
    // Trim here, at the parsing boundary. Real `git symbolic-ref` output ends
    // in a newline, and `$` without /m plus `.` (which excludes \n) means an
    // untrimmed value never matches — which silently returned null for every
    // real repo, nulling out every `unpushed` count. Callers must not have to
    // remember this.
    const m = String(originHeadRef).trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  const have = new Set(remoteBranches || []);
  for (const cand of BASE_FALLBACKS) if (have.has(cand)) return cand;
  return null;
}

module.exports = { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch };
