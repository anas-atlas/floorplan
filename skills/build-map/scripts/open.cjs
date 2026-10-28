'use strict';
// bm open [map]: show the owner's page. Reuses the running server (restarting it when this plugin version
// brings a newer one), otherwise starts it in the background, then opens the browser. Like Floorplan's open.mjs.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const lib = require('./lib.cjs');

const SERVER = path.join(__dirname, 'server.cjs');
const STATE = () => path.join(lib.DIR, '.server.json');
const IDLE_MINUTES = 240;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch (e) { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function status(s) {
  return new Promise(resolve => {
    const u = new URL(s.url);
    const req = http.get({ host: u.hostname, port: u.port, path: '/api/status', headers: { host: u.host, 'x-build-map-token': s.token }, timeout: 3000 }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(d) : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const portFree = port => new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });

function openBrowser(u) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); return true; } catch (e) { return false; }
}

async function open({ slug, port, noOpen = false } = {}) {
  if (slug) lib.read(slug); // fails early on a bad name
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(fs.readFileSync(SERVER)).update(fs.readFileSync(path.join(__dirname, '..', 'assets', 'index.html'))).digest('hex').slice(0, 12);
  let s = readState(), st = s && s.pid && alive(s.pid) ? await status(s) : null, note = 'reused the running page';
  if (st && st.hash !== hash) { try { process.kill(s.pid); } catch (e) { /* gone */ } for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(150); st = null; note = 'restarted the page with this version'; }
  if (!st) {
    const want = port || (s && s.port) || 4330;
    if (!(await portFree(want))) return { ok: false, text: `Port ${want} is in use by something that is not this plugin's build map page (an older copy started by hand?). Stop it, then run bm open again.` };
    const prev = s && s.pid;
    spawn(process.execPath, [SERVER, '--port', String(want), '--idle-exit', String(IDLE_MINUTES)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 50; i++) { await sleep(150); const n = readState(); if (n && n.pid !== prev && alive(n.pid)) { s = n; st = await status(s); if (st) break; } }
    if (!st) return { ok: false, text: 'The build map page did not start. Run node ' + SERVER + ' to see why.' };
    note = 'started the page';
  }
  const url = s.url + (slug ? '#/' + slug : '');
  const shown = st.tabs > 0 && !slug ? `already open in ${st.tabs} tab${st.tabs > 1 ? 's' : ''}` : noOpen ? 'not opened (--no-open)' : openBrowser(url) ? 'opened in the browser' : 'open it yourself';
  return { ok: true, url, text: `BUILD MAP  ${url}  (${note}; ${shown})\nIt stops ${IDLE_MINUTES / 60} hours after the last tab closes.` };
}

module.exports = { open };
