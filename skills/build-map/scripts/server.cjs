#!/usr/bin/env node
'use strict';
// Local build map server. Serves the page and a small JSON API over docs/build-maps/*.json.
// Binds to 127.0.0.1 only; pass --host <private address> to expose it on purpose.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib.cjs');
const repos = require('./repos.cjs');
const code = require('./code.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const HOST = opt('host', process.env.HOST || '127.0.0.1');
const PORT = +opt('port', process.env.PORT || 4330);
const PAGE = path.join(__dirname, '..', 'assets', 'index.html');
// Routes that start processes or read code take a token made at launch and handed only to the page itself (Floorplan's pattern):
// another website can't read the page, so it never learns the token.
const TOKEN = crypto.randomBytes(16).toString('hex');
const SELF_HASH = crypto.createHash('sha1').update(fs.readFileSync(__filename)).update(fs.readFileSync(PAGE)).digest('hex').slice(0, 12);
const STATE = path.join(lib.DIR, '.server.json');
const IDLE = +opt('idle-exit', 0) * 60000; // stop this long after the last page closes (0 = never)
// Linked local docs are shown read-only, and only from these folders (BUILD_MAP_DOC_ROOTS, separated by ":").
const DOC_ROOTS = (process.env.BUILD_MAP_DOC_ROOTS || [path.join(require('os').homedir(), 'Documents', 'Atlas'), lib.DIR].join(path.delimiter)).split(path.delimiter).filter(Boolean);
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.yml', '.yaml', '.xml', '.log', '.cls', '.js', '.cjs', '.html']);
const real = p => { try { return fs.realpathSync(p); } catch (e) { return ''; } };
// The file comes from the map's own link, never from the request, and must sit under a doc root after symlinks resolve.
function docFile(slug, i) {
  const map = lib.read(slug), link = ((map.deploy && map.deploy.links) || [])[+i];
  const p = link && real(lib.localPath(link));
  if (!p || !DOC_EXT.has(path.extname(p).toLowerCase())) return null;
  if (!DOC_ROOTS.map(real).filter(Boolean).some(r => p.startsWith(r + path.sep))) return null;
  const st = fs.statSync(p); return st.isFile() && st.size <= 2 * 1024 * 1024 ? { p, label: link[1] || link[0] } : null;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A small Markdown renderer: headings, lists, quotes, code, tables, rules and inline marks. Raw HTML stays text.
function inline(s) {
  const code = []; s = esc(s).replace(/`([^`]+)`/g, (_, c) => (code.push(c), `\u0000${code.length - 1}\u0000`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${code[n]}</code>`);
}
function markdown(src) {
  const L = src.replace(/\r/g, '').split('\n'), out = []; let i = 0;
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < L.length) {
    const l = L[i];
    if (/^\s*```/.test(l)) { const b = []; i++; while (i < L.length && !/^\s*```/.test(L[i])) b.push(L[i++]); i++; out.push(`<pre><code>${esc(b.join('\n'))}</code></pre>`); continue; }
    let m = l.match(/^(#{1,6})\s+(.*)$/); if (m) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(l) && /^\s*\|?\s*:?-{2,}/.test(L[i + 1] || '')) {
      const head = cells(l); i += 2; const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(cells(L[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^\s*>/.test(l)) { const b = []; while (i < L.length && /^\s*>/.test(L[i])) b.push(L[i++].replace(/^\s*>\s?/, '')); out.push(`<blockquote>${markdown(b.join('\n'))}</blockquote>`); continue; }
    m = l.match(/^\s*([-*+]|\d+[.)])\s+/); if (m) {
      const ol = /\d/.test(m[1]), items = [];
      while (i < L.length && /^\s*([-*+]|\d+[.)])\s+/.test(L[i])) { const ind = L[i].match(/^\s*/)[0].length; items.push(`<li${ind ? ` style="margin-left:${Math.min(ind, 8) * 0.6}em"` : ''}>${inline(L[i].replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''))}</li>`); i++; }
      out.push(`<${ol ? 'ol' : 'ul'}>${items.join('')}</${ol ? 'ol' : 'ul'}>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const p = []; while (i < L.length && L[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s|\s*\|)/.test(L[i])) p.push(L[i++]);
    if (!p.length) p.push(L[i++]); out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}
function docPage(title, file, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
:root { --bg: #f6f7f6; --panel: #fff; --fg: #1d2421; --muted: #66716c; --line: #d6dcd9; --accent: #2f6fb8; --code: #eef1ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #141917; --panel: #1c2320; --fg: #e3e9e6; --muted: #97a39e; --line: #2f3833; --accent: #6aa2e6; --code: #232b27; color-scheme: dark } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 "Atkinson Hyperlegible", system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 20px 16px 60px; }
.src { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); margin: 0 0 16px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; } h1 { font-size: 24px; margin-top: 0; } h2 { font-size: 19px; } h3 { font-size: 16px; }
a { color: var(--accent); } code { font: 13px ui-monospace, Menlo, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding: 2px 14px; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 14px; } th, td { border: 1px solid var(--line); padding: 5px 9px; text-align: left; vertical-align: top; } th { background: var(--panel); }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; } .plain { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, Menlo, monospace; }
</style></head><body><main><p class="src">${esc(file)} (read only)</p>${body}</main></body></html>`;
}

const clients = new Set();
const notify = slug => { for (const res of clients) res.write(`data: ${JSON.stringify({ slug })}\n\n`); };

// One watcher on the data folder: every write, by this server, the CLI or an agent editing the file, reaches open pages.
let debounce = {};
function watch() {
  fs.mkdirSync(lib.DIR, { recursive: true });
  fs.watch(lib.DIR, (ev, name) => {
    if (!name || !name.endsWith('.json') || name.startsWith('.')) return;
    const slug = name.slice(0, -5); clearTimeout(debounce[slug]);
    debounce[slug] = setTimeout(() => notify(slug), 120);
  });
}

const allowedHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`]);
function sendJson(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new lib.BuildMapError('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new lib.BuildMapError('body is not valid JSON')); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Host check blocks DNS rebinding; Origin + JSON content type block other websites from writing to this server.
    if (!allowedHosts().has(req.headers.host)) return sendJson(res, 403, { error: 'host not allowed' });
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      return res.end(fs.readFileSync(PAGE, 'utf8').replace('</head>', `<script>window.BM_SERVER=${JSON.stringify({ token: TOKEN })};</script></head>`));
    }
    if (p.startsWith('/api/status') || p.startsWith('/api/code/')) {
      const origin = req.headers.origin;
      if ((origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) || req.headers['x-build-map-token'] !== TOKEN) return sendJson(res, 403, { error: 'token required' });
      if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, { pid: process.pid, hash: SELF_HASH, tabs: clients.size, dir: lib.DIR });
      const c = p.match(/^\/api\/code\/([a-z0-9_-]+)(\/neighbors|\/serve)?$/);
      if (!c) return sendJson(res, 404, { error: 'not found' });
      const map = lib.read(c[1]), root = repos.repoOf(c[1]);
      if (req.method === 'GET' && !c[2]) return sendJson(res, 200, code.summary(map, root));
      if (req.method === 'GET' && c[2] === '/neighbors') {
        const g = root && code.graphOf(root), file = url.searchParams.get('file') || '';
        if (!g || !g.files.some(f => f.p === file)) return sendJson(res, 404, { error: 'not on the code map' });
        return sendJson(res, 200, code.neighbors(root, g, file));
      }
      if (req.method === 'POST' && c[2] === '/serve') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'send application/json' });
        if (!root || !code.graphOf(root)) return sendJson(res, 404, { error: 'no code map for this build map' });
        return sendJson(res, 200, { url: await code.startServer(root) });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (req.method === 'GET' && p === '/api/maps') return sendJson(res, 200, { maps: lib.list() });
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n'); clients.add(res);
      const beat = setInterval(() => res.write(': \n\n'), 25000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); }); return;
    }
    if (req.method === 'GET' && p === '/doc') {
      const slug = url.searchParams.get('map') || '', doc = lib.slugOk(slug) && docFile(slug, url.searchParams.get('i'));
      if (!doc) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('This link is not a readable file in an allowed folder.'); }
      const text = fs.readFileSync(doc.p, 'utf8'), md = /\.(md|markdown)$/i.test(doc.p);
      // No scripts, no outside requests: the doc is shown, never run.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'", 'x-content-type-options': 'nosniff' });
      return res.end(docPage(doc.label, doc.p, md ? markdown(text) : `<div class="plain">${esc(text)}</div>`));
    }
    let m = p.match(/^\/api\/map\/([a-z0-9_-]+)$/);
    if (m && req.method === 'GET') { const map = lib.read(m[1]); return sendJson(res, 200, { map, warnings: lib.validate(map) }); }
    m = p.match(/^\/api\/map\/([a-z0-9_-]+)\/(op|delete)$/);
    if (m && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) return sendJson(res, 403, { error: 'origin not allowed' });
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'send application/json' });
      const op = await body(req);
      if (m[2] === 'delete') { if (op.confirm !== m[1]) return sendJson(res, 400, { error: 'confirm with the map name' }); return sendJson(res, 200, lib.remove(m[1], op.cleanup)); }
      return sendJson(res, 200, { map: Array.isArray(op.ops) ? lib.applyMany(m[1], op.ops) : lib.apply(m[1], op) });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof lib.BuildMapError) return sendJson(res, err.message.startsWith('no map') ? 404 : 400, { error: err.message });
    console.error(err); sendJson(res, 500, { error: 'server error' });
  }
});

server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the build map server already running? Try --port <n>.` : err.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  watch();
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  try { fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: PORT, url, token: TOKEN, hash: SELF_HASH, startedAt: new Date().toISOString() }, null, 2)); } catch (e) { /* bm open just starts another */ }
  console.log(`Build maps: ${url}  (data: ${path.relative(process.cwd(), lib.DIR) || lib.DIR})`);
});
const forget = () => { try { if (JSON.parse(fs.readFileSync(STATE, 'utf8')).pid === process.pid) fs.unlinkSync(STATE); } catch (e) { /* gone */ } };
process.on('exit', forget);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
if (IDLE) { let last = Date.now(); setInterval(() => { if (clients.size) last = Date.now(); else if (Date.now() - last > IDLE) process.exit(0); }, 30000).unref(); }
