#!/usr/bin/env node
'use strict';
// The build map server on 127.0.0.1:4330: the Builds home, and every map as the Floorplan viewer with its
// build panel (on the repo's code map, or on an empty one when the map has no repo). One server for all
// repos: it also answers each viewer's Ask bar, flows and live reload, which a repo's own floorplan/serve.mjs
// does when it runs by itself.
// Binds to 127.0.0.1 only; pass --host <private address> to expose it on purpose.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lib = require('./lib.cjs');
const repos = require('./repos.cjs');
const code = require('./code.cjs');
const health = require('./health.cjs');
const page = require('./page.cjs');
const asking = require('./ask.cjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const HOST = opt('host', process.env.HOST || '127.0.0.1');
const PORT = +opt('port', process.env.PORT || 4330);
const HOME = path.join(__dirname, '..', 'assets', 'home.html');
// Every API route takes a token made at launch and handed only to the pages themselves (Floorplan's pattern):
// another website can't read the pages, so it never learns it. The home gets the launch token; each map page
// gets one derived from it that is good for that map only, and it routes the viewer's own calls (/api/ask...).
const TOKEN = crypto.randomBytes(16).toString('hex');
const mapToken = slug => `${slug}.${crypto.createHmac('sha256', TOKEN).update('map:' + slug).digest('hex').slice(0, 32)}`;
const SELF_HASH = page.hash();
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
// Floorplan's dark look, for linked docs.
function docPage(title, file, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${page.fontCss()}
:root { --bg: #0f0f0f; --panel: #191919; --fg: #ececec; --muted: #8b8b8b; --line: rgba(255,255,255,.1); --accent: #8fb4ff; --code: #232323; color-scheme: dark; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 60px; }
.src { font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--muted); margin: 0 0 16px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; letter-spacing: -.01em; } h1 { font-size: 24px; margin-top: 0; } h2 { font-size: 19px; } h3 { font-size: 16px; }
a { color: var(--accent); } code { font: 13px "JetBrains Mono", ui-monospace, monospace; background: var(--code); padding: 1px 5px; border-radius: 6px; }
pre { background: var(--code); padding: 12px; border-radius: 12px; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding: 2px 14px; border-left: 3px solid var(--line); color: var(--muted); }
table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 14px; } th, td { border: 1px solid var(--line); padding: 5px 9px; text-align: left; vertical-align: top; } th { background: var(--panel); }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; } .plain { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 "JetBrains Mono", ui-monospace, monospace; }
</style></head><body><main><p class="src">${esc(file)} (read only)</p>${body}</main></body></html>`;
}

// ========== open pages: live updates and idle shutdown ==========
// Each event stream is { res, slug, root, panel }: a map page's own stream reloads it when the code map is
// rebuilt; the build panel's stream (panel) and the home's hear about map changes.
const clients = new Set();
const tabs = () => [...clients].filter(c => !c.panel).length;
const sendTo = (c, event, data) => c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
let debounce = {};
function watch() {
  fs.mkdirSync(lib.DIR, { recursive: true });
  // One watcher on the data folder: every write, by this server, the CLI or an agent editing the file, reaches open pages.
  fs.watch(lib.DIR, (ev, name) => {
    if (!name || !name.endsWith('.json') || name.startsWith('.')) return;
    const slug = name.slice(0, -5); clearTimeout(debounce[slug]);
    debounce[slug] = setTimeout(() => { for (const c of clients) if (c.panel || !c.slug) sendTo(c, 'map', { slug }); }, 120);
  });
}
// A repo's code map is rebuilt: its open pages reload in place (the view lives in the URL hash).
const watchedRoots = new Set();
function watchGraph(root) {
  if (watchedRoots.has(root)) return; watchedRoots.add(root);
  let t = null;
  fs.watchFile(path.join(root, 'floorplan', 'graph.json'), { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(t); t = setTimeout(() => { for (const c of clients) if (c.root === root && !c.panel) sendTo(c, 'reload', {}); }, 800);
  });
}

// ========== what each page reads ==========
/** The repo and code map for a map, or nulls. */
function codeOf(slug) {
  const root = repos.repoOf(slug), graph = root && code.graphOf(root);
  return { root, graph };
}
function withHealth(x) {
  if (x.error) return x;
  try {
    const map = lib.read(x.slug), h = health.check(map, lib.validate), root = repos.repoOf(x.slug);
    return { ...x, rev: map.rev || 0, repo: root ? path.basename(root) : null, codeMap: !!(root && fs.existsSync(path.join(root, 'floorplan', 'graph.json'))),
      health: { important: h.filter(i => i.level === 'important').length, all: h.length } };
  } catch (e) { return x; }
}
/** Everything the build panel shows: the map as it is on disk, its checks, and its modules matched to the code map. */
function panelData(slug) {
  const map = lib.read(slug), { root, graph } = codeOf(slug);
  let codeInfo = { repo: root ? path.basename(root) : null, map: !!graph };
  if (graph) {
    const matches = code.matchModules(map, graph);
    codeInfo = { ...codeInfo, branch: repos.branchOf(root), project: graph.project && graph.project.name, stale: code.staleness(root, graph), matches };
  }
  return { slug, map, warnings: lib.validate(map), health: health.check(map, lib.validate), code: codeInfo };
}

// What the page may change. Every write is tagged "you" and goes through lib.applyMany, the code bm uses.
// Notes and answers wait as drafts until Send, exactly as on the classic page, so `bm wait` wakes once per batch.
const PAGE_OPS = {
  draft: ['match', 'answer', 'note', 'tuck', 'clear', 't', 'dropNote', 'discard'],
  send: [],
  order: ['ids'],
  decision: ['match', 'answer'], // only to take back a sent answer (answer: "")
  'qa-step': ['run', 'step', 'result', 'note', 'verdict'],
};
function pageOp(o) {
  if (!o || typeof o !== 'object' || !PAGE_OPS[o.op]) throw new lib.BuildMapError(`the page can't send "${o && o.op}" (${Object.keys(PAGE_OPS).join(', ')})`);
  if (o.op === 'decision' && o.answer !== '') throw new lib.BuildMapError('answers are drafted and sent; decision only clears an answer');
  const out = { op: o.op, by: 'you' };
  for (const k of PAGE_OPS[o.op]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// ========== pages ==========
function homePage() {
  return fs.readFileSync(HOME, 'utf8')
    .replace('/*__FONTS__*/', () => page.fontCss())
    .replace(/__LOGO__/g, () => page.dataUri('logo.png'))
    .replace(/__FAVICON__/g, () => page.dataUri('favicon.png'))
    .replace('</head>', () => `<script>window.BM_SERVER=${JSON.stringify({ token: TOKEN })};</script></head>`);
}
function mapPage(slug) {
  const map = lib.read(slug), { root, graph } = codeOf(slug), c = asking.cli();
  if (root && graph) watchGraph(root);
  const settings = { token: mapToken(slug), cli: !!(graph && c.claude), version: c.version, model: c.model };
  const bm = { slug, token: settings.token, feature: map.feature, repo: root ? path.basename(root) : null, codeMap: !!graph };
  const head = `<script>window.FLOORPLAN_SERVER=${JSON.stringify(settings)};window.BM=${JSON.stringify(bm).replace(/</g, '\\u003c')};</script>`;
  return page.viewer(graph || page.emptyGraph(map.feature, map.plan && map.plan.scope), { head });
}

const allowedHosts = () => new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`]);
function sendJson(res, code, body) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function sendHtml(res, code, html) { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); res.end(html); }
function body(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(new lib.BuildMapError('request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new lib.BuildMapError('body is not valid JSON')); } });
  });
}
/** Who a token speaks for: { home: true }, { slug }, or null. */
function scopeOf(given) {
  if (typeof given !== 'string' || !given) return null;
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (eq(given, TOKEN)) return { home: true };
  const m = given.match(/^([a-z0-9][a-z0-9_-]{0,63})\.[0-9a-f]{32}$/);
  return m && eq(given, mapToken(m[1])) ? { slug: m[1] } : null;
}
const flowsFile = root => path.join(root, 'floorplan', 'custom-flows.json');
const readFlows = root => { try { return JSON.parse(fs.readFileSync(flowsFile(root), 'utf8')).flows || []; } catch (e) { return []; } };

const server = http.createServer(async (req, res) => {
  try {
    // Host check blocks DNS rebinding; Origin + the token block other websites.
    if (!allowedHosts().has(req.headers.host)) return sendJson(res, 403, { error: 'host not allowed' });
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendHtml(res, 200, homePage());
    let m = p.match(/^\/m\/([^/]+)\/?$/);
    if (m && req.method === 'GET') {
      const slug = decodeURIComponent(m[1]);
      try { return sendHtml(res, 200, mapPage(slug)); }
      catch (err) { if (err instanceof lib.BuildMapError) return sendHtml(res, 404, docPage('No such map', 'build map', `<h1>No build map "${esc(slug)}"</h1><p><a href="/">All builds</a></p>`)); throw err; }
    }
    if (req.method === 'GET' && p === '/doc') {
      const slug = url.searchParams.get('map') || '', doc = lib.slugOk(slug) && docFile(slug, url.searchParams.get('i'));
      if (!doc) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('This link is not a readable file in an allowed folder.'); }
      const text = fs.readFileSync(doc.p, 'utf8'), md = /\.(md|markdown)$/i.test(doc.p);
      // No scripts, no outside requests: the doc is shown, never run.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src 'none'", 'x-content-type-options': 'nosniff' });
      return res.end(docPage(doc.label, doc.p, md ? markdown(text) : `<div class="plain">${esc(text)}</div>`));
    }
    if (!p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    // ========== API: every route needs a token, and a request from another origin is refused ==========
    const origin = req.headers.origin;
    if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) return sendJson(res, 403, { error: 'origin not allowed' });
    // EventSource can't send headers, so event streams take the token in the query string.
    const scope = scopeOf(req.headers['x-build-map-token'] || req.headers['x-floorplan-token'] || (p === '/api/events' ? url.searchParams.get('token') : null));
    if (!scope) return sendJson(res, 403, { error: 'token required' });
    const mine = slug => scope.home || scope.slug === slug;

    if (req.method === 'GET' && p === '/api/status') return sendJson(res, 200, { pid: process.pid, hash: SELF_HASH, tabs: tabs(), dir: lib.DIR });
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n'); // reconnect quickly after a restart
      const c = { res, slug: scope.slug || null, root: scope.slug ? repos.repoOf(scope.slug) : null, panel: url.searchParams.get('panel') === '1' };
      clients.add(c);
      const beat = setInterval(() => res.write(': \n\n'), 25000);
      req.on('close', () => { clearInterval(beat); clients.delete(c); lastTab = Date.now(); }); return;
    }
    if (req.method === 'GET' && p === '/api/maps') return sendJson(res, 200, { maps: lib.list().map(withHealth), cleanup: lib.cleanupList().length });
    m = p.match(/^\/api\/map\/([^/]+)(\/write)?$/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      if (!mine(slug)) return sendJson(res, 403, { error: 'this page has no access to that map' });
      if (req.method === 'GET' && !m[2]) return sendJson(res, 200, panelData(slug));
      if (req.method === 'POST' && m[2]) {
        // Writes come from a map page only: the home reads.
        if (!scope.slug) return sendJson(res, 403, { error: 'write from the map page' });
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'send application/json' });
        const b = await body(req), ops = (Array.isArray(b.ops) ? b.ops : [b]).map(pageOp);
        lib.applyMany(slug, ops);
        return sendJson(res, 200, panelData(slug));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ========== the viewer's own calls (what floorplan/serve.mjs answers), for the map page's repo ==========
    if (!scope.slug) return sendJson(res, 404, { error: 'not found' });
    const { root, graph } = codeOf(scope.slug);
    if (req.method === 'GET' && p === '/api/health') { const c = asking.cli(); return sendJson(res, 200, { cli: !!(graph && c.claude), version: c.version, path: (c.claude && c.claude.path) || null }); }
    if (p === '/api/flows') {
      if (req.method === 'GET') return sendJson(res, 200, { flows: graph ? readFlows(root) : [] });
      if (!graph) return sendJson(res, 404, { error: 'no code map for this build' });
      if (req.method === 'POST' || req.method === 'DELETE') {
        const b = await body(req, 50000);
        const flows = readFlows(root).filter(x => x.id !== b.id && x.id !== (b.flow && b.flow.id));
        if (req.method === 'POST' && b.flow && b.flow.id && Array.isArray(b.flow.steps)) flows.push({ ...b.flow, createdAt: new Date().toISOString() });
        fs.writeFileSync(flowsFile(root), JSON.stringify({ flows }, null, 2) + '\n');
        return sendJson(res, 200, { flows });
      }
    }
    // The Floorplan Cloud waitlist card stays off on the build map page.
    if (req.method === 'GET' && p === '/api/cloud/prompt') return sendJson(res, 200, { show: false });
    if (req.method === 'POST' && p === '/api/cancel') { if (root) asking.cancel(root); res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && p === '/api/ask') {
      const b = await body(req, 20000);
      if (!graph) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); return res.end(`event: failure\ndata: ${JSON.stringify({ code: 'cli_error', message: 'This build has no code map to ask about.' })}\n\n`); }
      return asking.ask(root, res, b);
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof lib.BuildMapError) return sendJson(res, err.message.startsWith('no map') ? 404 : 400, { error: err.message });
    console.error(err); if (!res.headersSent) sendJson(res, 500, { error: 'server error' }); else res.end();
  }
});

let lastTab = Date.now();
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the build map server already running? Try --port <n>.` : err.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  watch();
  const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
  try { fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: PORT, url, token: TOKEN, hash: SELF_HASH, startedAt: new Date().toISOString() }, null, 2)); } catch (e) { /* bm open just starts another */ }
  console.log(`Build maps: ${url}  (data: ${path.relative(process.cwd(), lib.DIR) || lib.DIR})`);
  // Finding the Claude Code CLI takes a moment: do it now, not on the first page.
  setImmediate(() => asking.cli());
});
const forget = () => { try { if (JSON.parse(fs.readFileSync(STATE, 'utf8')).pid === process.pid) fs.unlinkSync(STATE); } catch (e) { /* gone */ } };
process.on('exit', forget);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
if (IDLE) setInterval(() => { if (clients.size || asking.busy()) lastTab = Date.now(); else if (Date.now() - lastTab > IDLE) process.exit(0); }, 30000).unref();
