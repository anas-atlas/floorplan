'use strict';
// This repo is public: build maps (client names, decisions, notes) must never be committed to it.
// Maps live in ~/build-maps, outside every repo; this test catches one that slipped in before it is pushed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO } = require('./helpers.cjs');

/** A build map is a JSON object with a feature name, a stage and layers of modules. */
function looksLikeMap(text) {
  let j; try { j = JSON.parse(text); } catch (e) { return false; }
  return !!j && typeof j === 'object' && typeof j.feature === 'string' && j.feature.trim() !== '' && typeof j.stage === 'string' && Array.isArray(j.layers);
}

test('the map check spots a map and passes the empty template', () => {
  assert.equal(looksLikeMap(JSON.stringify({ feature: 'Cookie consent', stage: 'qa', layers: [] })), true);
  assert.equal(looksLikeMap(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'template.json'), 'utf8')), false);
  assert.equal(looksLikeMap('{"name":"atlas-floorplan"}'), false);
});

test('no tracked file in this repo is a build map', (t) => {
  let files;
  try { files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean); }
  catch (e) { return t.skip('not a git checkout'); }
  const maps = files.filter(f => /build-maps?\//.test(f) && f.endsWith('.json') && !f.startsWith('skills/build-map/scripts/'))
    .concat(files.filter(f => f.endsWith('.json') && fs.existsSync(path.join(REPO, f)) && fs.statSync(path.join(REPO, f)).size < 5 * 1024 * 1024 && looksLikeMap(fs.readFileSync(path.join(REPO, f), 'utf8'))));
  assert.deepEqual([...new Set(maps)], [], 'build maps belong in ~/build-maps, never in this repo');
});
