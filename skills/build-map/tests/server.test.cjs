'use strict';
// The page's server: 127.0.0.1 only, Host and Origin checks, and a per-launch token on the code routes.
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

test('server', async (t) => {
  const dir = tmp('srv'), port = 43000 + Math.floor(Math.random() * 2000);
  bm(dir, ['new', 'demo', 'Demo']);
  const child = spawn(process.execPath, [path.join(SKILL, 'scripts', 'server.cjs'), '--port', String(port)], { env: { ...process.env, BUILD_MAP_DIR: dir }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, '.server.json')); i++) await new Promise(r => setTimeout(r, 100));
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.server.json'), 'utf8'));
  assert.equal(state.url, `http://127.0.0.1:${port}`);

  await t.test('the page carries the token and cannot be framed', async () => {
    const r = await request(port, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(`window.BM_SERVER={"token":"${state.token}"}`));
    assert.equal(r.headers['x-frame-options'], 'DENY');
  });
  await t.test('maps and map reads work as before', async () => {
    assert.deepEqual(JSON.parse((await request(port, '/api/maps')).body).maps.map(m => m.slug), ['demo']);
    assert.equal(JSON.parse((await request(port, '/api/map/demo')).body).map.feature, 'Demo');
  });
  await t.test('code routes need the token', async () => {
    assert.equal((await request(port, '/api/code/demo')).status, 403);
    assert.equal((await request(port, '/api/code/demo', { headers: { 'x-build-map-token': 'wrong' } })).status, 403);
    const ok = await request(port, '/api/code/demo', { headers: { 'x-build-map-token': state.token } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { repo: null });
    assert.equal((await request(port, '/api/code/demo/serve', { method: 'POST', headers: { 'x-build-map-token': state.token, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  });
  await t.test('another Host or Origin is refused', async () => {
    assert.equal((await request(port, '/api/maps', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, '/api/map/demo/op', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"op":"stage","stage":"qa"}' })).status, 403);
  });
  await t.test('the state file goes when the server stops', async () => {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    assert.equal(fs.existsSync(path.join(dir, '.server.json')), process.platform === 'win32', 'removed on exit (Windows kills without a signal handler)');
  });
});
