'use strict';
// `bm` on the PATH: a tiny launcher in ~/.local/bin that runs the installed plugin's CLI, so `bm show <map>`
// works from any terminal or session. It looks the plugin up on every run, so plugin updates need no reinstall.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN = 'atlas-floorplan@atlas-floorplan';
const BIN = () => process.env.BM_SHIM_DIR || path.join(os.homedir(), '.local', 'bin');

const launcher = fallback => `#!/usr/bin/env node
// bm: runs the build map CLI from the installed ${PLUGIN} plugin (written by bm install-shim).
const fs = require('fs'), path = require('path'), os = require('os');
let cli = null;
try {
  const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
  const e = [].concat(all[${JSON.stringify(PLUGIN)}] || []).find(x => x && x.installPath && fs.existsSync(path.join(x.installPath, 'skills', 'build-map', 'scripts', 'bm.cjs')));
  if (e) cli = path.join(e.installPath, 'skills', 'build-map', 'scripts', 'bm.cjs');
} catch (err) { /* no plugin record: use the copy that wrote this file */ }
if (!cli && fs.existsSync(${JSON.stringify(fallback)})) cli = ${JSON.stringify(fallback)};
if (!cli) { console.error('bm: the ${PLUGIN} plugin is not installed. Install it from the Code tab (+, Add plugins).'); process.exit(1); }
process.argv.splice(1, 1, cli);
require(cli);
`;

function install() {
  const dir = BIN(), f = path.join(dir, 'bm');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes('bm install-shim')) return `${f} exists and was not written by bm; left it alone.`;
  fs.writeFileSync(f, launcher(path.join(__dirname, 'bm.cjs')), { mode: 0o755 });
  fs.chmodSync(f, 0o755);
  const onPath = (process.env.PATH || '').split(path.delimiter).some(p => path.resolve(p) === path.resolve(dir));
  return `ok · wrote ${f}${onPath ? '' : `\n${dir} is not on your PATH: add it in your shell profile.`}`;
}

module.exports = { install, launcher };
