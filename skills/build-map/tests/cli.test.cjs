'use strict';
// The CLI keeps working exactly as agents use it: same commands, same output, same JSON on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, bm } = require('./helpers.cjs');

test('new, mod-add, mod, show and list round trip', () => {
  const dir = tmp('cli');
  assert.match(bm(dir, ['new', 'demo', 'Demo feature', '--branch', 'feature/demo']).out, /created .*demo\.json/);
  assert.equal(bm(dir, ['mod-add', 'demo', 'Service', 'DemoService', '--what', 'does the work']).code, 0);
  assert.match(bm(dir, ['mod', 'demo', 'DemoService', '--code', 'committed']).out, /^ok · demo rev \d+/);
  const show = bm(dir, ['show', 'demo']).out;
  assert.match(show, /Demo feature {2}\[demo\] {2}stage: plan/);
  assert.match(show, /DemoService\s+committed\s+none/);
  assert.match(show, /built 1\/1 committed/);
  assert.match(bm(dir, ['list']).out, /^demo\s+plan\s+1\/1 committed/m);
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'demo.json'), 'utf8'));
  assert.equal(map.branch, 'feature/demo');
  assert.deepEqual(Object.keys(map).sort(), ['branch', 'deploy', 'feature', 'layers', 'log', 'now', 'org', 'plan', 'qa', 'rev', 'stage', 'tickets', 'updated'].sort(), 'no new fields in the map');
});

test('batch is one atomic write, and a bad op changes nothing', () => {
  const dir = tmp('batch');
  bm(dir, ['new', 'b', 'Batch']);
  const before = fs.readFileSync(path.join(dir, 'b.json'), 'utf8');
  const bad = bm(dir, ['batch', 'b', JSON.stringify([{ op: 'mod-add', layer: 'Service', id: 'A' }, { op: 'stage', stage: 'nope' }])]);
  assert.equal(bad.code, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), before);
  assert.equal(bm(dir, ['batch', 'b', JSON.stringify([{ op: 'mod-add', layer: 'Service', id: 'A' }, { op: 'stage', stage: 'build' }])]).code, 0);
  assert.match(bm(dir, ['show', 'b']).out, /stage: build/);
});

test('notes from the owner show first, and show --since lists only later changes', () => {
  const dir = tmp('since');
  bm(dir, ['new', 's', 'Since']);
  const rev = +bm(dir, ['mod-add', 's', 'Service', 'One']).out.match(/rev (\d+)/)[1];
  bm(dir, ['mod-add', 's', 'Service', 'Two']);
  bm(dir, ['op', 's', JSON.stringify({ op: 'now-add', t: 'Please rename Two', by: 'you' })]);
  const out = bm(dir, ['show', 's', '--since', String(rev)]).out;
  assert.match(out, /Added module Two/);
  assert.doesNotMatch(out, /Added module One/);
  assert.match(out, /NOTES FROM YOU \(open\):\n {2}\* Please rename Two/);
});

test('errors are one line on stderr with exit code 1', () => {
  const dir = tmp('err');
  const r = bm(dir, ['show', 'missing']);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'bm: no map "missing"');
});

test('health lists what is wrong with a map, worst first', () => {
  const dir = tmp('health');
  bm(dir, ['new', 'h', 'Health']);
  bm(dir, ['mod-add', 'h', 'Service', 'NotDone']);
  bm(dir, ['stage', 'h', 'deploy']);
  const out = bm(dir, ['health', 'h']).out;
  assert.match(out, /^h: \d+ to look at\n {2}important At deploy with 1 module not committed/);
});
