'use strict';
// Linking a map to its repo and its code map: found at run time from the checkout, by name, with no new map fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, bm, git, gitRepo } = require('./helpers.cjs');

process.env.BM_NO_REBUILD = '1';
const code = require('../scripts/code.cjs');

const APEX = 'force-app/main/default/classes';
const graph = (files, links = []) => ({
  meta: { generatedAt: '2026-10-28T10:00:00Z', repos: [] }, project: { name: 'Test org' }, links,
  files: files.map(([p, n]) => ({ p, n, name: path.basename(p) })),
});
const SAMPLE = graph([
  [`${APEX}/service/OrderSearchService.cls`, 'apex'],
  [`${APEX}/service/OrderSearchService.cls-meta.xml`, 'apex'],
  [`${APEX}/controller/OrderSearchController.cls`, 'apex'],
  ['force-app/main/default/lwc/orderSearch/orderSearch.html', 'ui'],
  ['force-app/main/default/lwc/orderSearch/orderSearch.js', 'ui'],
]);
const mapOf = (...ids) => ({ feature: 'Order search', stage: 'build', branch: 'feature/orders', layers: [{ name: 'Service', mods: ids.map(id => ({ id, code: 'committed', deployed: 'none' })) }] });

test('module ids match files by name: Apex class, LWC folder, nothing for prose', () => {
  const m = code.matchModules(mapOf('OrderSearchService', 'orderSearch LWC', 'Tests, UAT, deploy notes'), SAMPLE);
  assert.equal(m.OrderSearchService.file, `${APEX}/service/OrderSearchService.cls`);
  assert.equal(m['orderSearch LWC'].file, 'force-app/main/default/lwc/orderSearch/orderSearch.js');
  assert.equal(m['Tests, UAT, deploy notes'], undefined);
});

test('a deep link opens the file on its own board, inside a folder chip when the viewer groups them', () => {
  assert.equal(code.deepLink(SAMPLE, `${APEX}/service/OrderSearchService.cls`), '#v=n%3Aapex&s=f%3Aforce-app%2Fmain%2Fdefault%2Fclasses%2Fservice%2FOrderSearchService.cls');
  const big = graph([...Array.from({ length: 20 }, (_, i) => [`${APEX}/service/S${i}.cls`, 'apex']), ...Array.from({ length: 10 }, (_, i) => [`${APEX}/domain/D${i}.cls`, 'apex'])]);
  assert.match(code.deepLink(big, `${APEX}/domain/D3.cls`), /^#v=d%3Aapex%7Cforce-app%2Fmain%2Fdefault%2Fclasses%2Fdomain&s=/);
});

test('used by and uses come from import links, and from names for Apex', () => {
  const root = fs.realpathSync(tmp('nb'));
  const write = (p, t) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); };
  write(`${APEX}/service/OrderSearchService.cls`, 'public class OrderSearchService { }');
  write(`${APEX}/controller/OrderSearchController.cls`, 'public class OrderSearchController { OrderSearchService s; }');
  write('force-app/main/default/lwc/orderSearch/orderSearch.js', "import search from '@salesforce/apex/OrderSearchController.search';");
  write('force-app/main/default/lwc/orderSearch/orderSearch.html', '<template></template>');
  const g = { ...SAMPLE, links: [{ a: 'f:force-app/main/default/lwc/orderSearch/orderSearch.js', b: 'f:force-app/main/default/lwc/orderSearch/orderSearch.html', k: 'import' }] };
  const svc = code.neighbors(root, g, `${APEX}/service/OrderSearchService.cls`);
  assert.deepEqual(svc.usedBy.map(x => [x.file, x.via]), [[`${APEX}/controller/OrderSearchController.cls`, 'name']]);
  const ctl = code.neighbors(root, g, `${APEX}/controller/OrderSearchController.cls`);
  assert.deepEqual(ctl.uses.map(x => x.file), [`${APEX}/service/OrderSearchService.cls`]);
  assert.deepEqual(ctl.usedBy.map(x => x.file), ['force-app/main/default/lwc/orderSearch/orderSearch.js']);
  const js = code.neighbors(root, g, 'force-app/main/default/lwc/orderSearch/orderSearch.js');
  assert.deepEqual(js.uses.map(x => [x.file, x.via]), [[`${APEX}/controller/OrderSearchController.cls`, 'name'], ['force-app/main/default/lwc/orderSearch/orderSearch.html', 'import']]);
});

test('recent work: the map writes its own task and keeps everyone else\'s', () => {
  const root = fs.realpathSync(tmp('rw'));
  fs.mkdirSync(path.join(root, 'floorplan', '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'floorplan', 'graph.json'), JSON.stringify(SAMPLE));
  fs.writeFileSync(path.join(root, 'floorplan', 'recent-work.json'), JSON.stringify({ tasks: [{ title: 'Other work', items: [] }] }));
  const map = mapOf('OrderSearchService', 'Notes'); map.layers[0].mods[1].code = 'none';
  assert.match(code.writeRecent(root, 'orders', map), /1 file/);
  const rw = JSON.parse(fs.readFileSync(path.join(root, 'floorplan', 'recent-work.json'), 'utf8'));
  assert.deepEqual(rw.tasks.map(t => t.title), ['Order search', 'Other work']);
  assert.equal(rw.tasks[0].source, 'build-map:orders');
  assert.deepEqual(rw.tasks[0].items.map(i => i.ref), [`${APEX}/service/OrderSearchService.cls`]);
  assert.equal(code.writeRecent(root, 'orders', map), '', 'no rewrite when nothing changed');
});

test('the CLI links a map to the checkout on its branch, with a pointer block kept out of git', () => {
  const dir = tmp('link'), root = gitRepo('feature/orders');
  bm(dir, ['new', 'orders', 'Order search', '--branch', 'feature/orders']);
  const r = bm(dir, ['mod-add', 'orders', 'Service', 'OrderSearchService'], { cwd: path.join(root) });
  assert.match(r.out, /linked orders to /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.repos.json'), 'utf8')).orders.root, root);
  const local = fs.readFileSync(path.join(root, 'CLAUDE.local.md'), 'utf8');
  assert.match(local, /<!-- build-map:start -->[\s\S]*`orders`: Order search[\s\S]*<!-- build-map:end -->/);
  assert.equal(git(root, 'status', '--porcelain'), '', 'CLAUDE.local.md is ignored through .git/info/exclude');
  assert.doesNotMatch(bm(dir, ['list']).out, /repos/, 'the link file is not a map');
});

test('a map on main is only linked on purpose, with bm here', () => {
  const dir = tmp('main'), root = gitRepo('main');
  bm(dir, ['new', 'm', 'On main', '--branch', 'main']);
  bm(dir, ['mod-add', 'm', 'Service', 'X'], { cwd: root });
  assert.equal(fs.existsSync(path.join(dir, '.repos.json')), false);
  assert.match(bm(dir, ['here', 'm'], { cwd: root }).out, /is linked to/);
  assert.match(bm(dir, ['code', 'm'], { cwd: dir }).out, /has no code map yet/);
});

test('Floorplan\'s own block in CLAUDE.local.md is left alone', () => {
  const dir = tmp('both'), root = gitRepo('feature/x');
  const theirs = '<!-- floorplan:start -->\nFloorplan block\n<!-- floorplan:end -->\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.local.md'), theirs);
  bm(dir, ['new', 'x', 'X', '--branch', 'feature/x']);
  bm(dir, ['mod-add', 'x', 'Service', 'A'], { cwd: root });
  const text = fs.readFileSync(path.join(root, 'CLAUDE.local.md'), 'utf8');
  assert.ok(text.startsWith(theirs.trimEnd()));
  assert.match(text, /<!-- build-map:start -->/);
  bm(dir, ['stage', 'x', 'complete'], { cwd: root });
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.local.md'), 'utf8').trim(), theirs.trim(), 'a finished map drops out of the block');
});
