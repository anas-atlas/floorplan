'use strict';
// The Floorplan viewer page, put together from the plugin's own assets the same way floorplan's build.mjs
// does it, so the build map server can show any repo's code map (and a map with no repo) with the current
// ui/*.js, whichever plugin version built that repo's map. tests/page.test.mjs checks this stays identical
// to build.mjs's output, so an upstream change to the template shows up as a failing test.
const fs = require('fs');
const path = require('path');

const SKILL = path.join(__dirname, '..', '..', 'floorplan');
const ASSETS = path.join(SKILL, 'assets');
const read = (...p) => fs.readFileSync(path.join(ASSETS, ...p), 'utf8');
const dataUri = name => 'data:image/png;base64,' + fs.readFileSync(path.join(ASSETS, name)).toString('base64');
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// U+2028 and U+2029 end a line in a script, so they are escaped inside the inlined graph.
const LS = new RegExp(String.fromCharCode(0x2028), 'g'), PS = new RegExp(String.fromCharCode(0x2029), 'g');
const FONT_RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
let fontCache = null;
/** Inter and JetBrains Mono as inline @font-face rules: the pages make no outside requests. */
function fontCss() {
  return fontCache || (fontCache = [['Inter', 'inter'], ['JetBrains Mono', 'jetbrains-mono']].flatMap(([family, file]) => Object.entries(FONT_RANGES).map(([subset, range]) =>
    `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:100 900;unicode-range:${range};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ASSETS, 'vendor', 'fonts', `${file}-${subset}-wght-normal.woff2`)).toString('base64')}) format("woff2")}`)).join('\n'));
}

function uiScripts() {
  const dir = path.join(ASSETS, 'ui');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort().map(n => `<script>/* ui/${n} */\n${fs.readFileSync(path.join(dir, n), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`).join('\n') : '';
}

/** The viewer for a graph. `head` is extra markup placed before </head> (the server's settings). */
function viewer(graph, { title, head = '' } = {}) {
  const graphQuery = read('graph-query.js');
  const html = read('viewer.html')
    .replace('/*__GRAPH_QUERY__*/', () => graphQuery.replace(/<\/script/gi, '<\\/script'))
    .replace('<!--__ELK_SCRIPT__-->', () => `<script>${read('vendor', 'elk.bundled.js').replace(/<\/script/gi, '<\\/script')}</script>`)
    .replace('/*__FONTS__*/', () => fontCss())
    .replace('/*__FLOORPLAN_DATA__*/null', () => JSON.stringify(graph).replace(/<\/(script)/gi, '<\\/$1').replace(LS, '\\u2028').replace(PS, '\\u2029'))
    .replace(/__FLOORPLAN_TITLE__/g, () => escapeHtml(title || `${(graph.project && graph.project.name) || 'Code'} map`))
    .replace(/__FLOORPLAN_LOGO__/g, () => dataUri('logo.png'))
    .replace(/__FLOORPLAN_FAVICON__/g, () => dataUri('favicon.png'))
    .replace('<!--__UI_EXTENSIONS__-->', () => uiScripts());
  return head ? html.replace('</head>', () => head + '</head>') : html;
}

/** A graph with nothing in it, for a build map that has no code repo: the viewer shows only the build panel. */
function emptyGraph(name, summary) {
  return {
    schema: 'floorplan/graph@1',
    meta: { generatedAt: null, scanAt: null, rootName: name, root: null, audience: 'technical', repos: [], counts: { files: 0, loc: 0, unassigned: 0 } },
    project: { name, summary: summary || '' },
    nodes: [], files: [], routes: [], links: [], flows: [], tour: [], health: { issues: [] }, screens: [],
  };
}

/** A short hash of everything the build map server serves, so `bm open` restarts a server left from an older version. */
function hash() {
  const ui = path.join(ASSETS, 'ui');
  const files = [path.join(__dirname, 'server.cjs'), path.join(__dirname, 'ask.cjs'), __filename, path.join(__dirname, '..', 'assets', 'home.html'),
    path.join(ASSETS, 'viewer.html'), path.join(ASSETS, 'graph-query.js'), ...fs.readdirSync(ui).filter(n => n.endsWith('.js')).sort().map(n => path.join(ui, n))];
  const h = require('crypto').createHash('sha1');
  for (const f of files) h.update(fs.existsSync(f) ? fs.readFileSync(f) : '');
  return h.digest('hex').slice(0, 12);
}

module.exports = { viewer, emptyGraph, fontCss, dataUri, escapeHtml, hash, ASSETS };
