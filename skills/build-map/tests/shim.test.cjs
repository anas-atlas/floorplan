'use strict';
// The bm launcher in ~/.local/bin runs the installed plugin's CLI, and falls back to the copy that wrote it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmp, bm } = require('./helpers.cjs');

test('install-shim writes a launcher that runs the CLI', () => {
  const bin = tmp('bin'), home = tmp('home'), dir = tmp('maps');
  const env = { BM_SHIM_DIR: bin, HOME: home, USERPROFILE: home };
  assert.match(bm(dir, ['install-shim'], { env }).out, /ok · wrote/);
  bm(dir, ['new', 'viashim', 'Via shim']);
  const r = spawnSync(process.execPath, [path.join(bin, 'bm'), 'list'], { encoding: 'utf8', env: { ...process.env, ...env, BUILD_MAP_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^viashim\s+plan/m);
});

test('install-shim never overwrites a bm it did not write', () => {
  const bin = tmp('bin2'), dir = tmp('maps2');
  fs.writeFileSync(path.join(bin, 'bm'), '#!/bin/sh\necho mine\n');
  assert.match(bm(dir, ['install-shim'], { env: { BM_SHIM_DIR: bin } }).out, /left it alone/);
  assert.equal(fs.readFileSync(path.join(bin, 'bm'), 'utf8'), '#!/bin/sh\necho mine\n');
});
