'use strict';
// The link between a build map and the code: the repo's Floorplan map (<repo>/floorplan/graph.json).
// Modules point at code by name only, so the map format does not change: a module id such as
// "OrderSearchService" or "orderSearch LWC" is looked up as a file or LWC folder of that name.
// Everything here reads, except writeRecent, which writes floorplan/recent-work.json (git-ignored with
// the rest of that folder) so the code map lights up the same files the build map says were worked on.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { git } = require('./repos.cjs');

const A = x => Array.isArray(x) ? x : [];
const MAP_DIR = 'floorplan';
// The Floorplan skill ships next to this one in the plugin.
const FLOORPLAN_SCRIPTS = path.join(__dirname, '..', '..', 'floorplan', 'scripts');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
const graphOf = root => readJson(path.join(root, MAP_DIR, 'graph.json'));

// "MyClass.cls", "MyClass.cls-meta.xml", "My_Flow.flow-meta.xml", "lwc/myCmp/myCmp.js" all name "MyClass", "My_Flow", "myCmp".
const baseName = p => path.posix.basename(p).replace(/(-meta\.xml|\.xml)$/i, '').replace(/\.[^.]+$/, '').replace(/\.(flow|object|field|permissionset|layout|flexipage)$/i, '');
const COMPONENT = /\/(lwc|aura)\/([^/]+)\//;
// Which file stands for a name, best first: Apex and triggers, a component's main file, then anything else.
function rank(p, name) {
  const c = p.match(COMPONENT);
  if (/\.(cls|trigger)$/i.test(p)) return 0;
  if (c && c[2].toLowerCase() === name && new RegExp(`/${name}\\.(js|ts|cmp)$`, 'i').test(p)) return 1;
  if (c) return 3;
  return /-meta\.xml$/i.test(p) ? 4 : 2;
}

/** Index of the map's files by the names a module could use for them. */
function nameIndex(graph) {
  const idx = new Map();
  const add = (k, p) => { k = k.toLowerCase(); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(p); };
  for (const f of A(graph && graph.files)) {
    add(baseName(f.p), f.p);
    const c = f.p.match(COMPONENT); if (c && baseName(f.p).toLowerCase() !== c[2].toLowerCase()) add(c[2], f.p);
  }
  return idx;
}

/** The words in a module id that could be a file name: "orderSearch LWC" gives orderSearch. */
const candidates = id => String(id).split(/[^A-Za-z0-9_]+/).filter(w => w.length >= 3 && /^[A-Za-z]/.test(w) && !/^(lwc|aura|apex|class|trigger|flow|test|tests|and|the|for|with|new|page|component)$/i.test(w));

/** { moduleId: { file, node } } for the modules whose id names a file on the code map. */
function matchModules(map, graph) {
  const idx = nameIndex(graph), out = {}, files = new Map(A(graph && graph.files).map(f => [f.p, f]));
  for (const m of A(map.layers).flatMap(l => A(l.mods))) {
    for (const w of candidates(m.id)) {
      const hits = idx.get(w.toLowerCase()); if (!hits) continue;
      const best = [...hits].sort((a, b) => rank(a, w.toLowerCase()) - rank(b, w.toLowerCase()) || a.length - b.length)[0];
      out[m.id] = { file: best, node: files.get(best).n, name: files.get(best).name };
      break;
    }
  }
  return out;
}

/** The viewer's address for a file: its board (the node, or the folder chip a big node groups it into) and the card. */
function deepLink(graph, file) {
  const f = A(graph.files).find(x => x.p === file); if (!f) return '';
  const same = A(graph.files).filter(x => x.n === f.n);
  let v = 'n:' + f.n;
  // Mirrors the viewer: a node with more than 24 files of its own groups them by the folder after their common one.
  if (same.length > 24) {
    const dirs = same.map(x => path.posix.dirname(x.p).split('/'));
    let common = dirs[0].slice();
    for (const d of dirs) { let i = 0; while (i < common.length && d[i] === common[i]) i++; common = common.slice(0, i); }
    const mine = path.posix.dirname(f.p).split('/'), seg = mine[common.length];
    if (seg !== undefined) {
      const key = [...common, seg].join('/');
      if (same.filter(x => (path.posix.dirname(x.p) + '/').startsWith(key + '/')).length >= 2) v = `d:${f.n}|${key}`;
    }
  }
  return '#' + new URLSearchParams({ v, s: 'f:' + file }).toString();
}

/** How far the code map lags the checkout: commits and files changed since it was built, and uncommitted files. */
function staleness(root, graph) {
  const r = A(graph && graph.meta && graph.meta.repos).find(x => x.path === '.') || A(graph && graph.meta && graph.meta.repos)[0];
  if (!r || !r.head) return null;
  const abs = path.join(root, r.path), head = git(abs, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const files = head === r.head ? [] : (git(abs, ['diff', '--name-only', r.head, head]) || '').split('\n').filter(Boolean);
  const commits = head === r.head ? 0 : +(git(abs, ['rev-list', '--count', `${r.head}..${head}`]) || 0);
  return { builtAt: graph.meta.generatedAt, builtBranch: r.branch || '', branch: git(abs, ['branch', '--show-current']) || '', commits, files: files.length, sample: files.slice(0, 5),
    dirty: (git(abs, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length, lags: files.length > 0 || (r.branch && r.branch !== git(abs, ['branch', '--show-current'])) };
}

// Text files where Salesforce code names other code (no imports to follow there).
const NAMED_REFS = /\.(cls|trigger|js|html|cmp|page|component)$|\.flow-meta\.xml$/i;
/** What a file uses and what uses it: the map's import links, plus, for code with no imports (Apex, Flows), names found in other files. */
function neighbors(root, graph, file) {
  const fid = 'f:' + file, label = new Map(A(graph.files).map(f => [f.p, f.name]));
  const uses = new Map(), usedBy = new Map();
  for (const l of A(graph.links)) {
    if (l.a === fid && l.b.startsWith('f:')) uses.set(l.b.slice(2), 'import');
    if (l.b === fid && l.a.startsWith('f:')) usedBy.set(l.a.slice(2), 'import');
  }
  const name = baseName(file), files = A(graph.files).map(f => f.p).filter(p => NAMED_REFS.test(p));
  const own = p => p === file || baseName(p) === name || (file.match(COMPONENT) && p.match(COMPONENT) && file.match(COMPONENT)[2] === p.match(COMPONENT)[2]);
  const read = p => { try { const s = fs.statSync(path.join(root, p)); return s.size < 512 * 1024 ? fs.readFileSync(path.join(root, p), 'utf8') : ''; } catch (e) { return ''; } };
  const word = n => new RegExp(`\\b${n.replace(/[^A-Za-z0-9_]/g, '')}\\b`);
  if (name.length >= 3 && /\.(cls|trigger)$|\.flow-meta\.xml$/i.test(file)) {
    const re = word(name);
    for (const p of files) if (!own(p) && !usedBy.has(p) && re.test(read(p))) usedBy.set(p, 'name');
  }
  const text = read(file);
  if (text) {
    const byName = new Map(files.filter(p => /\.(cls|trigger)$/i.test(p) && !own(p)).map(p => [baseName(p), p]));
    for (const [n, p] of byName) if (!uses.has(p) && n.length >= 3 && word(n).test(text)) uses.set(p, 'name');
  }
  const out = m => [...m].map(([p, via]) => ({ file: p, name: label.get(p) || baseName(p), via })).sort((a, b) => a.file.localeCompare(b.file)).slice(0, 30);
  return { uses: out(uses), usedBy: out(usedBy) };
}

/** The Floorplan server running for this repo, if any: { url, pid }. */
function serverOf(root) {
  const s = readJson(path.join(root, MAP_DIR, '.cache', 'server.json'));
  if (!s || !s.pid || !s.url) return null;
  try { process.kill(s.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  return { url: s.url, pid: s.pid };
}

/** Starts (or reuses) the repo's Floorplan server without opening a browser. Resolves to its URL or null. */
function startServer(root) {
  return new Promise(resolve => {
    const open = path.join(FLOORPLAN_SCRIPTS, 'open.mjs');
    if (!fs.existsSync(open)) return resolve(null);
    const child = spawn(process.execPath, [open, root, '--no-open'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => child.kill(), 30000);
    child.on('close', () => { clearTimeout(t); const s = serverOf(root); resolve(s ? s.url : null); });
  });
}

/** Everything the hub's Code map tab shows for a map. */
function summary(map, root) {
  if (!root) return { repo: null };
  const graph = graphOf(root);
  if (!graph) return { repo: root, branch: git(root, ['branch', '--show-current']) || '', map: false };
  const matches = matchModules(map, graph);
  for (const k of Object.keys(matches)) matches[k].link = deepLink(graph, matches[k].file);
  const srv = serverOf(root);
  return { repo: root, branch: git(root, ['branch', '--show-current']) || '', map: true, project: graph.project && graph.project.name, stale: staleness(root, graph), matches, url: srv && srv.url };
}

// ---------- shared recent work ----------
const SOURCE = slug => 'build-map:' + slug;
/** Writes this map's modules into floorplan/recent-work.json as one task, keeping every other task. Returns a note or ''. */
function writeRecent(root, slug, map) {
  const graph = graphOf(root); if (!graph) return '';
  const matches = matchModules(map, graph), mods = A(map.layers).flatMap(l => A(l.mods));
  const items = mods.filter(m => matches[m.id] && m.code !== 'none').map(m => ({ ref: matches[m.id].file, change: 'changed', note: `${m.id}: ${m.what || (m.code === 'committed' ? 'committed' : 'written')} (build map)` }));
  const f = path.join(root, MAP_DIR, 'recent-work.json'), cur = readJson(f) || { tasks: [] };
  const others = A(cur.tasks).filter(t => t && t.source !== SOURCE(slug));
  const committed = mods.filter(m => m.code === 'committed').length;
  const task = items.length ? [{ source: SOURCE(slug), title: String(map.feature).split(/\s+/).slice(0, 5).join(' '), request: (map.plan && map.plan.scope) || map.feature,
    summary: `From the build map "${slug}": ${committed} of ${mods.length} modules committed, stage ${map.stage}.`, items }] : [];
  const before = JSON.stringify(A(cur.tasks).filter(t => t && t.source === SOURCE(slug)));
  if (before === JSON.stringify(task)) return '';
  fs.writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), tasks: [...task, ...others] }, null, 2) + '\n');
  rebuild(root);
  return `code map recent work: ${items.length} file${items.length === 1 ? '' : 's'}`;
}

/** Rebuilds the code map in the background so the new highlights show; open tabs reload on their own. */
function rebuild(root) {
  const build = path.join(FLOORPLAN_SCRIPTS, 'build.mjs');
  if (!fs.existsSync(build) || process.env.BM_NO_REBUILD) return;
  const log = fs.openSync(path.join(root, MAP_DIR, '.cache', 'build-map-rebuild.log'), 'w');
  spawn(process.execPath, [build, root], { cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
}

module.exports = { graphOf, matchModules, deepLink, staleness, neighbors, serverOf, startServer, summary, writeRecent, candidates, baseName };
