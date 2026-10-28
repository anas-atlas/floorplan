'use strict';
// The Ask bar for the code maps the build map server shows. A port of floorplan's assets/serve.mjs
// (find the Claude Code CLI, run `claude -p` in the repo root with read-only tools, stream progress and the
// answer as server-sent events), so one server can answer for every repo. The instructions and answer
// schema come from the repo's own floorplan/query.mjs, exactly as serve.mjs loads them.
// Keep the spawn arguments and the event names in step with serve.mjs when upstream changes them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

function which(cmd) {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
  catch (e) { return []; }
}
/** { cmd, args, path } to spawn, or null. Same search as serve.mjs: FLOORPLAN_CLAUDE, the PATH, ~/.local/bin, npm shims. */
function resolveClaude() {
  const explicit = process.env.FLOORPLAN_CLAUDE;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = explicit ? [explicit] : [...which('claude'), path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ...(process.platform === 'win32' ? [path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')] : [])];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (/\.(m?js)$/i.test(c)) return { cmd: process.execPath, args: [c], path: c };
    if (/\.(cmd|bat|ps1)$/i.test(c) || (process.platform === 'win32' && !path.extname(c))) {
      const cli = path.join(path.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli], path: c };
      const exe = c.replace(/\.(cmd|bat|ps1)$/i, '.exe');
      if (fs.existsSync(exe)) return { cmd: exe, args: [], path: exe };
      continue;
    }
    return { cmd: c, args: [], path: c };
  }
  return null;
}
// Started from inside a Claude Code session? Don't let the CLI think it's nested in it.
function claudeEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|HOST|SDK)|^CLAUDECODE$/.test(k)) delete env[k];
  return env;
}

let claude, version;
/** The CLI and its version, looked up once (it takes a few seconds). */
function cli() {
  if (claude === undefined) {
    claude = resolveClaude(); version = null;
    if (claude) { try { version = execFileSync(claude.cmd, [...claude.args, '--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* unknown version */ } }
  }
  return { claude, version, model: process.env.FLOORPLAN_MODEL || null };
}

// Per repo: the graph lookups and the instructions, rebuilt when the repo's query.mjs changes.
const cores = new Map();
function core(root) {
  const f = path.join(root, 'floorplan', 'query.mjs'), g = path.join(root, 'floorplan', 'graph.json');
  const stamp = fs.statSync(f).mtimeMs + ':' + fs.statSync(g).mtimeMs, had = cores.get(root);
  if (had && had.stamp === stamp) return had;
  const src = fs.readFileSync(f, 'utf8').split('// ---- cli ----')[0];
  const c = new Function(`${src.replace(/^import .*$/gm, '')}; return { FLOORPLAN_ANSWER_SCHEMA, FLOORPLAN_FLOW_SCHEMA, floorplanAskInstructions, floorplanFlowInstructions, createGraphQuery };`)();
  const G = JSON.parse(fs.readFileSync(g, 'utf8'));
  const out = { stamp, q: c.createGraphQuery(G), modes: {
    ask: { instructions: c.floorplanAskInstructions(G, 'cli'), schema: JSON.stringify(c.FLOORPLAN_ANSWER_SCHEMA) },
    flow: { instructions: c.floorplanFlowInstructions(G, 'cli'), schema: JSON.stringify(c.FLOORPLAN_FLOW_SCHEMA) },
  } };
  cores.set(root, out); return out;
}

function describeTool(root, q, name, input = {}) {
  const nameFor = id => { try { return (q.brief(id) || {}).name || id; } catch (e) { return id; } };
  const rel = p => String(p || '').replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '');
  if (name === 'Bash') {
    const parts = String(input.command || '').split(/\s*(?:&&|;|\|\|)\s*/).map(c => /query\.mjs\s+(\w+)\s*(.*)$/.exec(c)).filter(Boolean);
    if (!parts.length) return 'Running a command';
    const one = ([, cmd, rest]) => {
      const a = rest.replace(/--\w+\s+\S+/g, '').replace(/["']/g, '').trim();
      return { overview: 'Reading the map overview', find: `Searching the map for "${a}"`, show: `Looking at ${a.split(/\s+/).map(nameFor).join(', ')}`, path: `Tracing a path ${a.split(/\s+/).map(nameFor).join(' → ')}` }[cmd] || 'Querying the map';
    };
    return parts.slice(0, 2).map(one).join(' · ') + (parts.length > 2 ? ` (+${parts.length - 2} more)` : '');
  }
  if (name === 'Read') return `Reading ${rel(input.file_path)}`;
  if (name === 'Grep') return `Searching code for "${input.pattern}"`;
  if (name === 'Glob') return `Listing ${input.pattern}`;
  return name;
}
function parseAnswer(ev) {
  if (ev.structured_output && typeof ev.structured_output === 'object') return ev.structured_output;
  const t = String(ev.result || ''), fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  for (const cand of [t, fence && fence[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) { try { const v = JSON.parse(cand); if (v && typeof v === 'object') return v; } catch (e) { /* next */ } }
  return { title: 'Answer', answer: t, items: [] };
}

const running = new Map();
/** Answers one question (body.question, body.mode, body.session) about the repo at root, as an event stream on res. */
function ask(root, res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const { claude: c, model } = cli();
  if (!c) { send('failure', { code: 'cli_missing', message: 'Claude Code CLI not found.' }); return res.end(); }
  let k; try { k = core(root); } catch (e) { send('failure', { code: 'cli_error', message: 'This repo has no built code map to ask about.' }); return res.end(); }
  const mode = k.modes[body.mode] || k.modes.ask;
  const args = [...c.args, '-p', '--output-format', 'stream-json', '--verbose', '--json-schema', mode.schema, '--append-system-prompt', mode.instructions,
    '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', 'Bash(node floorplan/query.mjs:*)', 'Read', 'Grep', 'Glob'];
  if (body.session) args.push('--resume', String(body.session));
  if (model) args.push('--model', model);
  const child = spawn(c.cmd, args, { cwd: root, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const id = crypto.randomBytes(6).toString('hex');
  running.set(id, { child, root }); send('start', { id });
  child.stdin.end(String(body.question || '').slice(0, 4000));
  let buf = '', stderr = '', done = false;
  child.stdout.on('data', d => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (ev.type === 'assistant') for (const x of (ev.message && ev.message.content) || []) if (x.type === 'tool_use') send('progress', { text: describeTool(root, k.q, x.name, x.input) });
      if (ev.type === 'result') {
        done = true;
        if (ev.is_error) { const msg = String(ev.result || ev.subtype || 'Claude Code reported an error'); send('failure', { code: /not logged in|\/login|authenticat/i.test(msg) ? 'not_logged_in' : 'cli_error', message: msg }); }
        else send('answer', { ...parseAnswer(ev), session: ev.session_id });
      }
    }
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  child.on('error', e => { if (!done) { done = true; send('failure', { code: 'cli_error', message: e.message }); } res.end(); });
  child.on('close', code => {
    running.delete(id);
    if (!done) send('failure', { code: /not logged in|\/login/i.test(stderr) ? 'not_logged_in' : 'cli_error', message: stderr.trim() || `claude exited with code ${code}` });
    res.end();
  });
  // The tab went away or Stop was pressed: don't leave Claude working.
  res.on('close', () => { if (!done) child.kill(); });
}
/** Stop: ends the questions running for this repo (serve.mjs has one repo, so it ends all). */
function cancel(root) { for (const r of running.values()) if (r.root === root) r.child.kill(); }
const busy = () => running.size;

module.exports = { ask, cancel, busy, cli };
