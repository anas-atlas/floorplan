'use strict';
// The build map server: the Builds home, each map as the Floorplan viewer with its build panel, the one write
// endpoint, and the viewer's own calls. 127.0.0.1 only, Host and Origin checks, and a per-launch token on every API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { tmp, bm, SKILL } = require('./helpers.cjs');

function request(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const json = r => JSON.parse(r.body);

test('server', async (t) => {
  const dir = tmp('srv'), port = 43000 + Math.floor(Math.random() * 2000);
  bm(dir, ['new', 'demo', 'Demo']);
  bm(dir, ['new', 'other', 'Other']);
  bm(dir, ['decision-add', 'demo', 'Which colour?', '--opt', '*Blue', '--opt', 'Green']);
  bm(dir, ['qa-run', 'demo', '--step', 'Loads:pass', '--step', 'Saves:open']);
  const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'server.cjs'), '--port', String(port)],
    { env: { ...process.env, BUILD_MAP_DIR: dir, FLOORPLAN_CLAUDE: path.join(dir, 'no-such-cli') }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, '.server.json')); i++) await new Promise(r => setTimeout(r, 100));
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.server.json'), 'utf8'));
  assert.equal(state.url, `http://127.0.0.1:${port}`);
  const home = { 'x-build-map-token': state.token };
  const page = await request(port, '/m/demo'), demoToken = (page.body.match(/window\.BM=(\{.*?\});/) || [])[1] && JSON.parse(page.body.match(/window\.BM=(\{.*?\});/)[1]).token;
  const mapHdr = { 'x-build-map-token': demoToken };
  const write = (slug, ops, headers = mapHdr, extra = {}) => request(port, `/api/map/${slug}/write`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...extra }, body: JSON.stringify({ ops }) });

  await t.test('the Builds home carries the launch token and cannot be framed', async () => {
    const r = await request(port, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(`window.BM_SERVER={"token":"${state.token}"}`));
    assert.match(r.body, /<title>Builds<\/title>/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });
  await t.test('the home lists every map, with whether it has a repo', async () => {
    const r = json(await request(port, '/api/maps', { headers: home }));
    assert.deepEqual(r.maps.map(m => m.slug).sort(), ['demo', 'other']);
    const demo = r.maps.find(m => m.slug === 'demo');
    assert.equal(demo.repo, null); assert.equal(demo.codeMap, false); assert.equal(demo.forYou, 1);
  });
  await t.test('a map opens as the Floorplan viewer with the build panel, and a token good for that map only', async () => {
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('/* ui/60-build.js */'), 'the build panel is inlined');
    assert.ok(page.body.includes('window.FLOORPLAN_SERVER={"token":"demo.'), 'the viewer gets the map token');
    assert.match(demoToken, /^demo\.[0-9a-f]{32}$/);
    assert.ok(!page.body.includes(state.token), 'the launch token stays on the home');
    assert.equal((await request(port, '/m/nope')).status, 404);
  });
  await t.test('every API call needs a token', async () => {
    assert.equal((await request(port, '/api/maps')).status, 403);
    assert.equal((await request(port, '/api/map/demo')).status, 403);
    assert.equal((await request(port, '/api/map/demo', { headers: { 'x-build-map-token': 'wrong' } })).status, 403);
    assert.equal((await request(port, '/api/map/demo', { headers: { 'x-build-map-token': 'demo.' + '0'.repeat(32) } })).status, 403);
    assert.equal(json(await request(port, '/api/map/demo', { headers: mapHdr })).map.feature, 'Demo');
    assert.equal(json(await request(port, '/api/map/demo', { headers: home })).map.feature, 'Demo');
  });
  await t.test("a map page can't read or write another map", async () => {
    assert.equal((await request(port, '/api/map/other', { headers: mapHdr })).status, 403);
    assert.equal((await write('other', [{ op: 'draft', t: 'hi' }])).status, 403);
  });
  await t.test('another Host or Origin is refused', async () => {
    assert.equal((await request(port, '/api/maps', { headers: { host: 'evil.example', ...home } })).status, 403);
    assert.equal((await request(port, '/', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await write('demo', [{ op: 'draft', t: 'hi' }], mapHdr, { origin: 'https://evil.example' })).status, 403);
  });
  await t.test('the write endpoint: JSON only, map pages only, and only the owner\'s ops', async () => {
    assert.equal((await request(port, '/api/map/demo/write', { method: 'POST', headers: { ...mapHdr, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await write('demo', [{ op: 'draft', t: 'hi' }], home)).status, 403, 'the home only reads');
    const stage = await write('demo', [{ op: 'stage', stage: 'complete' }]);
    assert.equal(stage.status, 400); assert.match(json(stage).error, /can't send "stage"/);
    assert.equal((await write('demo', [{ op: 'decision', match: 0, answer: 'Blue' }])).status, 400, 'answers are drafted, then sent');
    assert.equal((await write('demo', [{ op: 'draft', t: '' }])).status, 400, 'lib.cjs checks the op');
  });
  await t.test('a bad map name is refused', async () => {
    const r = await request(port, '/api/map/-bad/write', { method: 'POST', headers: { 'content-type': 'application/json', 'x-build-map-token': demoToken }, body: '{}' });
    assert.equal(r.status, 403);
    // A token can only be made for a valid name, so the bad name never reaches the store; lib.cjs refuses it too.
    assert.throws(() => require('../scripts/lib.cjs').file('-bad'), /bad map name/);
    assert.equal((await request(port, '/api/map/..%2Fdemo', { headers: home })).status, 400);
  });
  await t.test('notes, answers and QA verdicts go through the same code as bm, tagged you', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8')).rev;
    assert.equal((await write('demo', [{ op: 'draft', match: 0, answer: 'Blue', note: 'darker' }, { op: 'draft', t: 'Please add a test' }])).status, 200);
    const sent = json(await write('demo', [{ op: 'send' }]));
    assert.equal(sent.map.handoff.n, 2);
    assert.equal(json(await write('demo', [{ op: 'qa-step', step: 'Saves', result: 'fail', by: 'agent' }])).map.qa[0].steps[1][1], 'fail');
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8'));
    assert.ok(map.rev > before);
    assert.deepEqual(map.log.slice(0, 2).map(l => [l[1], l[2]]), [['QA: Saves fail', 'you'], ['You sent 2 answers', 'you']], 'a by from the page is ignored');
    const show = bm(dir, ['show', 'demo']).out;
    assert.match(show, /NOTES FROM YOU \(open\):\n {2}\* Please add a test\n {2}\* Decision 0 "Which colour\?": Blue \| note: darker/);
  });
  await t.test("the viewer's own calls answer for the map's repo, and a map with no repo has nothing to ask", async () => {
    assert.equal(json(await request(port, '/api/health', { headers: { 'x-floorplan-token': demoToken } })).cli, false);
    assert.deepEqual(json(await request(port, '/api/flows', { headers: { 'x-floorplan-token': demoToken } })), { flows: [] });
    assert.deepEqual(json(await request(port, '/api/cloud/prompt', { headers: { 'x-floorplan-token': demoToken } })), { show: false });
    const ask = await request(port, '/api/ask', { method: 'POST', headers: { 'x-floorplan-token': demoToken, 'content-type': 'application/json' }, body: '{"question":"hi"}' });
    assert.match(ask.body, /event: failure/);
    assert.equal((await request(port, '/api/health', { headers: home })).status, 404, 'the home has no repo');
    const st = json(await request(port, '/api/status', { headers: home }));
    assert.equal(st.pid, child.pid); assert.equal(st.hash, state.hash);
  });
  await t.test('the state file goes when the server stops', async () => {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    assert.equal(fs.existsSync(path.join(dir, '.server.json')), process.platform === 'win32', 'removed on exit (Windows kills without a signal handler)');
  });
});

test('a map linked to a repo opens on that repo\'s code map', async (t) => {
  const { gitRepo } = require('./helpers.cjs');
  const dir = tmp('srvcode'), port = 45000 + Math.floor(Math.random() * 2000);
  const root = gitRepo('feature/x', { 'force-app/main/default/classes/OrderService.cls': 'public class OrderService {}\n' });
  bm(dir, ['new', 'x', 'X feature', '--branch', 'feature/x']);
  bm(dir, ['mod-add', 'x', 'Apex', 'OrderService', '--code', 'committed'], { cwd: root });
  const graph = { schema: 'floorplan/graph@1', meta: { repos: [{ path: '.', head: 'x' }], counts: {} }, project: { name: 'Shop' },
    nodes: [{ id: 'apex', parent: null, label: 'Apex', kind: 'service', tags: [], paths: [], packages: [], hosts: [], stats: {} }],
    files: [{ p: 'force-app/main/default/classes/OrderService.cls', n: 'apex', name: 'Order service', l: 'apex', loc: 1, d: '' }], routes: [], links: [], flows: [], tour: [] };
  fs.mkdirSync(path.join(root, 'floorplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'floorplan', 'graph.json'), JSON.stringify(graph));
  const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'server.cjs'), '--port', String(port)], { env: { ...process.env, BUILD_MAP_DIR: dir, FLOORPLAN_CLAUDE: path.join(dir, 'no-such-cli') }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, '.server.json')); i++) await new Promise(r => setTimeout(r, 100));
  const page = await request(port, '/m/x');
  assert.ok(page.body.includes('"project":{"name":"Shop"}'), 'the repo graph is inlined');
  assert.match(page.body, /window\.BM=\{[^<]*"codeMap":true/);
  const token = JSON.parse(page.body.match(/window\.BM=(\{.*?\});/)[1]).token;
  const d = json(await request(port, '/api/map/x', { headers: { 'x-build-map-token': token } }));
  assert.equal(d.code.repo, path.basename(root));
  assert.deepEqual(d.code.matches.OrderService.file, 'force-app/main/default/classes/OrderService.cls');
  const maps = json(await request(port, '/api/maps', { headers: { 'x-build-map-token': JSON.parse(fs.readFileSync(path.join(dir, '.server.json'), 'utf8')).token } })).maps;
  assert.equal(maps[0].codeMap, true);
});
