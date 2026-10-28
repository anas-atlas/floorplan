'use strict';
// Which repo a map belongs to, found at run time (no field in the map): when the CLI runs inside a git
// checkout whose branch is the map's branch, that checkout is remembered in <maps>/.repos.json, next to the
// maps and outside every repo. `bm here <map>` records it on purpose, for maps on main or with no branch.
// The repo also gets a short pointer block in its CLAUDE.local.md, so later sessions there find the map.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib.cjs');

const REPOS = () => path.join(lib.DIR, '.repos.json');
// A map on one of these branches could be any checkout of the repo, so it is never matched on its own.
const SHARED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk']);

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); }
  catch (e) { return null; }
}
const repoRoot = cwd => git(cwd, ['rev-parse', '--show-toplevel']);
const branchOf = root => git(root, ['branch', '--show-current']) || '';

function readAll() { try { const r = JSON.parse(fs.readFileSync(REPOS(), 'utf8')); return r && typeof r === 'object' ? r : {}; } catch (e) { return {}; } }
function writeAll(all) {
  fs.mkdirSync(lib.DIR, { recursive: true });
  const tmp = REPOS() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, REPOS());
}

/** The checkout this map was last seen in, if it still exists. */
function repoOf(slug) {
  const r = readAll()[slug];
  return r && r.root && fs.existsSync(path.join(r.root, '.git')) ? r.root : null;
}

/** The repo at cwd if it belongs to the map: same branch, and not a shared branch unless forced. */
function detect(map, cwd, force) {
  const root = repoRoot(cwd || process.cwd());
  if (!root) return null;
  if (force) return root;
  const want = String(map.branch || '').trim();
  if (!want || SHARED_BRANCHES.has(want)) return null;
  return branchOf(root) === want ? root : null;
}

/** Remembers the repo for a map and refreshes the repo's pointer block. Returns a note, or '' when nothing changed. */
function remember(slug, root) {
  const all = readAll(), had = all[slug] && all[slug].root;
  if (had !== root) { all[slug] = { root, at: lib.today() }; writeAll(all); }
  const note = writePointer(root);
  return had === root ? '' : `linked ${slug} to ${root}${note ? ' (' + note + ')' : ''}`;
}

// ---------- CLAUDE.local.md pointer block ----------
// Its own markers, so it never touches Floorplan's block in the same file. <!-- build-map:off --> opts out.
const START = '<!-- build-map:start -->';
const END = '<!-- build-map:end -->';
const NAME = 'CLAUDE.local.md';

function block(entries) {
  return `${START}
## Build map

This work is tracked on a build map, the owner's only view of the build. Run \`bm show <map>\` before you start, act on "NOTES FROM YOU", and keep it updated as you work (the build-map skill says how):

${entries.map(e => `- \`${e.slug}\`: ${e.feature} (stage ${e.stage})`).join('\n')}
${END}`;
}

/** Maps linked to this checkout that are still in progress. */
function mapsIn(root) {
  const all = readAll();
  return Object.keys(all).filter(s => all[s].root === root).map(s => { try { const m = lib.read(s); return { slug: s, feature: m.feature, stage: m.stage }; } catch (e) { return null; } })
    .filter(e => e && !['complete', 'archive'].includes(e.stage)).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Adds CLAUDE.local.md to the repo's own ignore list unless git already ignores it (the same rule Floorplan uses). */
function excludeLocally(root) {
  if (git(root, ['ls-files', '--', NAME])) return `${NAME} is committed here; the block shows in it`;
  if (git(root, ['check-ignore', '-q', NAME]) !== null) return '';
  const excl = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excl) return 'could not find .git/info/exclude';
  const f = path.resolve(root, excl), line = '/' + NAME;
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, cur.replace(/\s*$/, cur.trim() ? '\n' : '') + `# personal Claude Code notes (added by the build map)\n${line}\n`);
  }
  return '';
}

function writePointer(root) {
  const f = path.join(root, NAME), old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  if (old && old.includes('<!-- build-map:off -->')) return '';
  const entries = mapsIn(root), a = old ? old.indexOf(START) : -1, b = old ? old.indexOf(END) : -1;
  let next;
  if (!entries.length) next = a >= 0 && b > a ? (old.slice(0, a).trimEnd() + '\n' + old.slice(b + END.length).trimStart()).replace(/^\n+/, '') : old;
  else if (old == null) next = block(entries) + '\n';
  else next = a >= 0 && b > a ? old.slice(0, a) + block(entries) + old.slice(b + END.length) : old.replace(/\s*$/, '') + '\n\n' + block(entries) + '\n';
  if (next === old || next == null) return '';
  fs.writeFileSync(f, next);
  return excludeLocally(root) || `${old == null ? 'created' : 'updated'} ${NAME}`;
}

module.exports = { git, repoRoot, branchOf, repoOf, detect, remember, writePointer, readAll, SHARED_BRANCHES, START, END };
