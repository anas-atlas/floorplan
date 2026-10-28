'use strict';
// Shared setup: every test gets its own maps folder and repos in a temp dir, never ~/build-maps.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SKILL = path.join(__dirname, '..');
const BM = path.join(SKILL, 'scripts', 'bm.cjs');
const REPO = path.join(SKILL, '..', '..');

function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `bm-${name}-`)); }

/** Runs the CLI with its own maps folder. Returns { out, err, code }. */
function bm(dir, args, opts = {}) {
  const r = spawnSync(process.execPath, [BM, ...args], { cwd: opts.cwd || dir, encoding: 'utf8', env: { ...process.env, BUILD_MAP_DIR: dir, BM_NO_REBUILD: '1', ...opts.env } });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A small git repo on the given branch with the given files committed. */
function gitRepo(branch, files = {}) {
  const root = fs.realpathSync(tmp('repo'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'user.name', 'Test');
  git(root, 'checkout', '-q', '-b', branch);
  for (const [p, text] of Object.entries({ 'README.md': 'test\n', ...files })) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); }
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'start');
  return root;
}

module.exports = { SKILL, BM, REPO, tmp, bm, git, gitRepo };
