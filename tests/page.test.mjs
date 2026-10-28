// The build map server shows each repo's code map with a viewer it puts together itself
// (skills/build-map/scripts/page.cjs), so it always carries the current ui/*.js. That page must stay
// identical to the one build.mjs writes: when an upstream change moves the template, this fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { shopApp, scanAndBuild, readGraph, cleanup, REPO } from './helpers.mjs';

const require = createRequire(import.meta.url);
const page = require(path.join(REPO, 'skills', 'build-map', 'scripts', 'page.cjs'));
let root;
before(() => { root = shopApp(); scanAndBuild(root); });
after(() => cleanup(root));

test("the build map server's viewer is the same page build.mjs writes", () => {
  const built = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.equal(page.viewer(readGraph(root)), built);
});

test('the build panel is in every map but stays off outside the build map server', () => {
  const built = fs.readFileSync(path.join(root, 'floorplan', 'index.html'), 'utf8');
  assert.ok(built.includes('/* ui/60-build.js */'));
  const src = fs.readFileSync(path.join(REPO, 'skills', 'floorplan', 'assets', 'ui', '60-build.js'), 'utf8');
  assert.match(src, /if \(!SC \|\| !BM \|\| !BM\.slug\) return;/);
  // it reaches the viewer only through window.Floorplan, like every ui module
  assert.doesNotMatch(src.replace(/window\.(Floorplan|BM|FloorplanTour)\b/g, ''), /window\.[A-Z]/);
});

test('a map with no repo gets an empty graph the viewer accepts', () => {
  const g = page.emptyGraph('Cookie banner', 'scope');
  for (const k of ['nodes', 'files', 'routes', 'links', 'flows', 'tour']) assert.deepEqual(g[k], [], k);
  const html = page.viewer(g, { head: '<script>window.BM={}</script>' });
  assert.match(html, /<title>Cookie banner map<\/title>/);
  assert.ok(html.indexOf('window.BM={}') < html.indexOf('</head>'));
});
