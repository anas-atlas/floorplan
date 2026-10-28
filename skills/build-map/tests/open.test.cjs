'use strict';
// bm open starts the page once and reuses it after.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, bm } = require('./helpers.cjs');

test('bm open starts the page, then reuses it', (t) => {
  const dir = tmp('open'), port = String(45000 + Math.floor(Math.random() * 2000));
  bm(dir, ['new', 'o', 'Open me']);
  t.after(() => { try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, '.server.json'), 'utf8')).pid); } catch (e) { /* stopped */ } });
  const first = bm(dir, ['open', 'o', '--port', port, '--no-open']);
  assert.equal(first.code, 0, first.out + first.err);
  assert.match(first.out, new RegExp(`BUILD MAP  http://127\\.0\\.0\\.1:${port}/m/o  \\(started the page`));
  assert.match(bm(dir, ['open', '--no-open']).out, /reused the running page/);
});

test('bm open --classic starts the 0.1.x page on its own port, for one release', (t) => {
  const dir = tmp('classic'), port = String(47000 + Math.floor(Math.random() * 2000));
  bm(dir, ['new', 'c', 'Classic']);
  t.after(() => { try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, '.server-classic.json'), 'utf8')).pid); } catch (e) { /* stopped */ } });
  const r = bm(dir, ['open', 'c', '--classic', '--port', port, '--no-open']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`CLASSIC BUILD MAP  http://127\\.0\\.0\\.1:${port}#/c  \\(started the page`));
  assert.ok(!fs.existsSync(path.join(dir, '.server.json')), 'the new page is not started');
});
