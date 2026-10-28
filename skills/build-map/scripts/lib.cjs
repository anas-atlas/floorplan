'use strict';
// Build map store: one JSON file per feature, plus the small set of operations everything shares.
// The server, the CLI and the page all go through apply(), so an agent and a human can both edit
// without overwriting each other: ops are applied to the latest file on disk, never to a stale copy.
const fs = require('fs');
const path = require('path');

// Maps live outside the clone (default ~/build-maps) so pulling tool updates never touches your data.
const DIR = process.env.BUILD_MAP_DIR ? path.resolve(process.env.BUILD_MAP_DIR) : path.join(require('os').homedir(), 'build-maps');
// Deleted maps go to the macOS Trash, so a delete can still be undone from Finder until the Trash is emptied.
const TRASH = process.env.BUILD_MAP_TRASH ? path.resolve(process.env.BUILD_MAP_TRASH) : path.join(require('os').homedir(), '.Trash');
// Cleanup the owner ticked when deleting a map (branch, worktree, sessions), waiting for an agent to carry it out.
const CLEANUP = () => path.join(DIR, '.cleanup.json');
// The lifecycle steps, then two resting states: complete (shipped) and archive (shelved, keeps the step it left in `was`).
// `plan` is the older name for the first step and is still accepted.
// Inputs are not a step: the owner can be asked for one at any step (decision-add --kind input), so they live in the Inbox.
const FLOW = ['grill', 'spec', 'build', 'qa', 'review', 'deploy', 'quiz', 'close'];
const STAGES = [...FLOW, 'plan', 'complete', 'archive'];
// The step an item, Now line or module belongs to, so each step's view on the page shows its own things.
const STEPS = [...FLOW, 'complete'];
const STAGE_NAMES = { grill: 'Grill', spec: 'Spec', plan: 'Plan', build: 'Build', qa: 'QA', review: 'Review', deploy: 'Deploy', quiz: 'Quiz', close: 'Close', complete: 'Complete', archive: 'Archive' };
// What the owner is asked for: a choice (decision), something to hand over (input) or a yes/no on agent work (approve).
// At most this many agent lines in Now at once (one per working agent plus blockers).
const NOW_CAP = 5;
const KINDS = ['decision', 'input', 'approve'];
const CODES = ['none', 'written', 'committed'];
const DEPLOYS = ['none', 'sandbox', 'prod'];
const RESULTS = ['pass', 'fail', 'open'];
const CODE_LABEL = { none: 'not built', written: 'written', committed: 'committed' };

class BuildMapError extends Error {}
const fail = msg => { throw new BuildMapError(msg); };

const slugOk = s => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(s));
const file = slug => { if (!slugOk(slug)) fail(`bad map name "${slug}" (use a-z, 0-9, - and _)`); return path.join(DIR, slug + '.json'); };
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const A = x => Array.isArray(x) ? x : [];

function format(map) {
  const prim = '(?:"(?:[^"\\\\\\n]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)';
  const pair = `"[^"\\n]*":\\s*${prim}`;
  return JSON.stringify(map, null, 2)
    .replace(new RegExp(`\\[\\s+(${prim}(?:,\\s+${prim})*)\\s+\\]`, 'g'), (_, body) => '[' + body.replace(/,\s+/g, ', ') + ']')
    .replace(new RegExp(`\\{\\s+(${pair}(?:,\\s+${pair})*)\\s+\\}`, 'g'), (all, body) => { const one = '{ ' + body.replace(/,\s+/g, ', ') + ' }'; return one.length <= 120 ? one : all; }) + '\n';
}

function validate(map) {
  const e = [];
  if (!map || typeof map !== 'object') return ['not an object'];
  if (!map.feature) e.push('feature is required');
  if (!STAGES.includes(map.stage)) e.push(`stage must be one of ${STAGES.join(', ')}`);
  A(map.layers).forEach(l => A(l.mods).forEach(m => {
    if (!m.id) e.push(`a module in "${l.name}" has no id`);
    if (!CODES.includes(m.code)) e.push(`${m.id}: code must be one of ${CODES.join(', ')}`);
    if (!DEPLOYS.includes(m.deployed)) e.push(`${m.id}: deployed must be one of ${DEPLOYS.join(', ')}`);
  }));
  A(map.plan && map.plan.decisions).forEach((d, i) => {
    if (d.kind !== undefined && !KINDS.includes(d.kind)) e.push(`decision ${i}: kind must be one of ${KINDS.join(', ')}`);
    if (d.opts !== undefined && !Array.isArray(d.opts)) e.push(`decision ${i}: opts must be a list`);
  });
  const steps = [...A(map.qa).flatMap(r => A(r.steps)), ...A(map.deploy && map.deploy.checks)];
  steps.forEach(s => { if (!RESULTS.includes(s[1])) e.push(`result "${s[1]}" must be one of ${RESULTS.join(', ')}`); });
  return e;
}

function read(slug) {
  let raw;
  try { raw = fs.readFileSync(file(slug), 'utf8'); } catch (err) { if (err.code === 'ENOENT') fail(`no map "${slug}"`); throw err; }
  let map;
  try { map = JSON.parse(raw); } catch (err) { fail(`${slug}.json is not valid JSON: ${err.message}`); }
  return upgrade(map);
}

// Older maps had an Inputs step between Spec and Build. A map left there is past its spec, so it reads as Build,
// and items tagged with that step simply stay in the Inbox. The next write saves the upgrade.
function upgrade(map) {
  if (map.stage === 'inputs') map.stage = 'build';
  if (map.was === 'inputs') map.was = 'build';
  [...A(map.plan && map.plan.decisions), ...A(map.now)].forEach(x => { if (x && x.step === 'inputs') delete x.step; });
  return map;
}
const NOT_A_STEP = 'inputs is not a step: ask for an input at any step with decision-add --kind input, and it shows in the Inbox';

function atomicWrite(p, text) {
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

// A tiny cross-process lock so the server and a CLI call never interleave a read-modify-write.
function withLock(slug, fn) {
  const lock = file(slug) + '.lock';
  fs.mkdirSync(DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); } catch (e) { /* raced */ }
      if (Date.now() - start > 5000) fail(`${slug} is locked by another writer`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch (e) { /* gone */ } }
}

function write(slug, map) {
  fs.mkdirSync(DIR, { recursive: true });
  map.rev = (map.rev || 0) + 1;
  atomicWrite(file(slug), format(map));
  return map;
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json') && slugOk(f.slice(0, -5))).map(f => {
    const slug = f.slice(0, -5);
    try {
      const m = read(slug), mods = A(m.layers).flatMap(l => A(l.mods));
      return { slug, feature: m.feature, stage: m.stage, was: m.was, branch: m.branch, updated: m.updated, total: mods.length,
        committed: mods.filter(x => x.code === 'committed').length, prod: mods.filter(x => x.deployed === 'prod').length,
        open: A(m.plan && m.plan.decisions).filter(d => !d.done).length, blocked: A(m.now).some(n => n.blocked), drafts: draftCount(m),
        forYou: A(m.plan && m.plan.decisions).filter(d => !d.done && !(d.a && d.aBy === 'you')).length };
    } catch (err) { return { slug, feature: slug, error: err.message }; }
  }).sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
}

function findMod(map, key, layer) {
  const all = A(map.layers).flatMap(l => A(l.mods).map(m => [l, m]));
  const k = String(key).toLowerCase();
  let hit = all.filter(([l, m]) => m.id === key && (!layer || l.name === layer));
  if (!hit.length) hit = all.filter(([l, m]) => String(m.id).toLowerCase().includes(k) && (!layer || l.name === layer));
  if (hit.length !== 1) fail(hit.length ? `"${key}" matches ${hit.length} modules: ${hit.map(h => h[1].id).join(', ')}` : `no module matching "${key}"`);
  return hit[0];
}
function findIdx(items, key, what, textOf) {
  if (typeof key === 'number' || /^\d+$/.test(String(key))) { const i = +key; if (!items[i]) fail(`no ${what} #${i}`); return i; }
  const hits = items.map((x, i) => [x, i]).filter(([x]) => textOf(x).toLowerCase().includes(String(key).toLowerCase()));
  if (hits.length !== 1) fail(hits.length ? `"${key}" matches ${hits.length} ${what}s` : `no ${what} matching "${key}"`);
  return hits[0][1];
}
// What a module calls or reads, by module id: the build diagram draws one arrow per entry.
const usesOf = v => [...new Set((Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean))].slice(0, 20);
const oneOf = (v, set, name) => { if (!set.includes(v)) fail(`${name} must be one of ${set.join(', ')}`); return v; };
const stepOf = v => { if (v === 'inputs') fail(NOT_A_STEP); return oneOf(v, STEPS, 'step'); };

// Each op mutates the map and returns the default log line (or '' for none). op.log overrides it, op.quiet drops it.
const OPS = {
  stage(map, o) {
    if (o.stage === 'inputs') fail(NOT_A_STEP);
    oneOf(o.stage, STAGES, 'stage');
    if (o.stage === 'archive' && map.stage !== 'archive') map.was = map.stage; else if (o.stage !== 'archive') delete map.was;
    map.stage = o.stage; return o.stage === 'archive' ? 'Archived' : `Stage set to ${STAGE_NAMES[o.stage]}`;
  },
  mod(map, o) {
    const [, m] = findMod(map, o.id, o.layer);
    if (o.code !== undefined) m.code = oneOf(o.code, CODES, 'code');
    if (o.deployed !== undefined) m.deployed = oneOf(o.deployed, DEPLOYS, 'deployed');
    if (o.what !== undefined) m.what = o.what;
    if (o.ticket !== undefined) m.ticket = o.ticket;
    if (o.lane !== undefined) { if (o.lane) m.lane = String(o.lane).slice(0, 60); else delete m.lane; }
    if (o.uses !== undefined) { const u = usesOf(o.uses); if (u.length) m.uses = u; else delete m.uses; }
    if (o.sub !== undefined) { if (o.sub) m.sub = String(o.sub).slice(0, 40); else delete m.sub; }
    if (o.group !== undefined) { if (o.group) m.group = String(o.group).slice(0, 40); else delete m.group; }
    // A rename carries every link to the module with it: other modules' uses and the actors' entry points.
    if (o.rename !== undefined && o.rename !== m.id) {
      const to = String(o.rename).trim(), from = m.id; if (!to) fail('--rename needs the new id');
      if (A(map.layers).some(l => A(l.mods).some(x => x !== m && x.id === to))) fail(`a module "${to}" already exists`);
      m.id = to;
      for (const x of [...A(map.layers).flatMap(l => A(l.mods)), ...A(map.actors)]) if (A(x.uses).includes(from)) x.uses = usesOf(x.uses.map(u => u === from ? to : u));
      return `Renamed ${from} to ${to}`;
    }
    return `${m.id}: ${CODE_LABEL[m.code]}${m.deployed !== 'none' ? ', ' + m.deployed : ''}`;
  },
  'mod-add'(map, o) {
    if (!o.id) fail('mod-add needs an id');
    map.layers = A(map.layers);
    let l = map.layers.find(x => x.name === o.layer);
    if (!l) { if (!o.layer) fail('mod-add needs a layer'); l = { name: o.layer, mods: [] }; map.layers.push(l); }
    const m = { id: o.id, code: oneOf(o.code || 'none', CODES, 'code'), deployed: oneOf(o.deployed || 'none', DEPLOYS, 'deployed') };
    if (o.what) m.what = o.what; if (o.ticket) m.ticket = o.ticket; if (o.lane) m.lane = String(o.lane).slice(0, 60);
    if (o.uses) { const u = usesOf(o.uses); if (u.length) m.uses = u; } if (o.sub) m.sub = String(o.sub).slice(0, 40); if (o.group) m.group = String(o.group).slice(0, 40);
    l.mods.push(m); return `Added module ${o.id}`;
  },
  // Now is for work in progress and blockers only, so agents get a small cap and no repeats.
  // Results, FYIs and review notes belong in the log; questions for the owner are Inbox items.
  'now-add'(map, o) {
    if (!o.t) fail('now-add needs text'); map.now = A(map.now);
    const t = String(o.t).slice(0, 300);
    if (o.by !== 'you') {
      const mine = map.now.filter(n => n.by !== 'you');
      if (mine.some(n => n.t === t)) fail('that Now line is already there');
      if (mine.length >= NOW_CAP) fail(`Now already has ${NOW_CAP} agent lines; it holds only work in progress and blockers. Close one with bm now-done, put results, FYIs and review notes in bm log, and questions for the owner in bm decision-add.`);
    }
    const n = { t, who: o.who || '', at: today() }; if (o.by) n.by = o.by; if (o.blocked) n.blocked = true; if (o.step) n.step = stepOf(o.step);
    map.now.push(n); return o.by === 'you' ? `Note added: ${n.t}` : '';
  },
  'now-done'(map, o) { map.now = A(map.now); const i = findIdx(map.now, o.match, 'Now item', x => x.t); const [n] = map.now.splice(i, 1); return `Done: ${n.t}`; },
  decision(map, o) {
    map.plan = map.plan || { scope: '', decisions: [] }; const ds = map.plan.decisions = A(map.plan.decisions);
    if (o.add) {
      const d = { t: String(o.add).slice(0, 500), done: !!o.done };
      // Lean fields: a short title for the row, one line of context, the options offered, and whether it belongs to the grill.
      if (o.kind) d.kind = oneOf(o.kind, KINDS, 'kind');
      if (o.short) d.short = String(o.short).slice(0, 60);
      if (o.ctx) d.ctx = String(o.ctx).slice(0, 300);
      if (o.opts) d.opts = A(o.opts).slice(0, 5).map(parseOpt);
      if (o.grill) d.grill = true;
      if (o.step) d.step = stepOf(o.step);
      if (o.answer) { d.a = String(o.answer).slice(0, 500); d.aBy = o.by || 'agent'; }
      ds.push(d); return `${o.done ? 'Decided' : 'Open question'}: ${d.short || d.t}`;
    }
    const d = ds[findIdx(ds, o.match, 'decision', x => x.t + ' ' + (x.short || ''))];
    // An answer is the owner's reply on the item itself; it stays open until the agent applies it and marks it done.
    if (o.answer !== undefined || o.note !== undefined) {
      if (o.answer !== undefined) {
        const a = String(o.answer).trim().slice(0, 500);
        if (a) { d.a = a; d.aBy = o.by || 'agent'; } else { delete d.a; delete d.aBy; delete d.note; }
      }
      if (o.note !== undefined) { const n = String(o.note).trim().slice(0, 500); if (n) d.note = n; else delete d.note; }
      // Tucked: the owner set it aside without choosing; it leaves their view and the agent sees it as an answer.
      if (o.tuck) d.tucked = true; else if (o.answer !== undefined) delete d.tucked;
      if (o.done === undefined) return d.a ? `Answered: ${(d.short || d.t).slice(0, 60)}: ${d.a}` : `Answer cleared: ${d.short || d.t}`;
    }
    d.done = o.done === undefined ? !d.done : !!o.done; return `${d.done ? 'Decided' : 'Reopened'}: ${d.t}`;
  },
  // The owner's drag order for open items: `ids` are decision indexes, first = most important. Indexes stay stable.
  order(map, o) {
    const ds = A(map.plan && map.plan.decisions), ids = A(o.ids).map(Number);
    ids.forEach((i, p) => { if (!ds[i]) fail(`no decision #${i}`); ds[i].ord = p; });
    return '';
  },
  'qa-run'(map, o) {
    map.qa = A(map.qa);
    const run = { run: o.run || (Math.max(0, ...map.qa.map(r => +r.run || 0)) + 1), when: o.when || today(), env: o.env || map.org || '', plan: o.plan || '', verdict: o.verdict || '',
      steps: A(o.steps).map(s => { const [n, r, w] = Array.isArray(s) ? s : String(s).split(':'); return [n, oneOf(r || 'open', RESULTS, 'result'), w || '']; }) };
    map.qa.unshift(run); return `QA run ${run.run}: ${run.verdict || run.steps.filter(s => s[1] === 'pass').length + '/' + run.steps.length + ' pass'}`;
  },
  'qa-step'(map, o) {
    const r = A(map.qa).find(x => String(x.run) === String(o.run)) || A(map.qa)[0]; if (!r) fail('no QA run yet');
    r.steps = A(r.steps); const i = r.steps.findIndex(s => s[0].toLowerCase() === String(o.step).toLowerCase());
    const row = [o.step, oneOf(o.result, RESULTS, 'result'), o.note || (i >= 0 ? r.steps[i][2] : '')];
    if (i >= 0) r.steps[i] = row; else r.steps.push(row); if (o.verdict) r.verdict = o.verdict;
    return `QA: ${o.step} ${o.result}`;
  },
  check(map, o) {
    map.deploy = map.deploy || {}; const cs = map.deploy.checks = A(map.deploy.checks);
    const i = cs.findIndex(s => s[0].toLowerCase() === String(o.name).toLowerCase()); const row = [o.name, oneOf(o.result, RESULTS, 'result'), o.note || ''];
    if (i >= 0) cs[i] = row; else cs.push(row); return `${o.name}: ${o.result}${o.note ? ' (' + o.note + ')' : ''}`;
  },
  link(map, o) {
    map.deploy = map.deploy || {}; const ls = map.deploy.links = A(map.deploy.links);
    const i = ls.findIndex(s => s[0].toLowerCase() === String(o.label).toLowerCase()); const row = [o.label, o.text, o.url || ''];
    if (i >= 0) ls[i] = row; else ls.push(row); return '';
  },
  meta(map, o) {
    for (const k of ['feature', 'branch', 'org']) if (o[k] !== undefined) map[k] = o[k];
    if (o.tickets !== undefined) map.tickets = A(o.tickets);
    if (o.scope !== undefined) { map.plan = map.plan || { scope: '', decisions: [] }; map.plan.scope = o.scope; } return '';
  },
  // Who uses the build (a guest, a staff user): the top of the build diagram. Each actor lists the modules it enters by.
  actor(map, o) {
    if (!o.name) fail('actor needs a name'); map.actors = A(map.actors);
    const i = map.actors.findIndex(a => String(a.name).toLowerCase() === String(o.name).toLowerCase());
    if (o.remove) { if (i < 0) fail(`no actor "${o.name}"`); map.actors.splice(i, 1); if (!map.actors.length) delete map.actors; return ''; }
    const a = i >= 0 ? map.actors[i] : map.actors[map.actors.push({ name: String(o.name).slice(0, 40) }) - 1];
    if (o.uses !== undefined) { const u = usesOf(o.uses); if (u.length) a.uses = u; else delete a.uses; }
    return '';
  },
  log(map, o) { if (!o.text) fail('log needs text'); return o.text; },
  // Drafts: the owner's picks, notes and set-asides wait here until they press Send, so a waiting agent wakes once
  // per batch instead of once per answer. Agents never read drafts; `send` turns them into real answers and notes.
  draft(map, o) {
    if (o.discard) { delete map.draft; return ''; }
    const dr = map.draft = map.draft || {}; dr.items = dr.items || {}; dr.notes = A(dr.notes);
    if (o.t !== undefined) { const t = String(o.t).trim().slice(0, 300); if (!t) fail('a note needs text'); dr.notes.push(t); }
    else if (o.dropNote !== undefined) { if (!dr.notes[+o.dropNote]) fail(`no draft note #${o.dropNote}`); dr.notes.splice(+o.dropNote, 1); }
    else {
      const i = +o.match; if (!A(map.plan && map.plan.decisions)[i]) fail(`no decision #${o.match}`);
      if (o.clear) delete dr.items[i];
      else {
        const a = String(o.answer ?? '').trim().slice(0, 500), n = String(o.note ?? '').trim().slice(0, 500); if (!a) fail('a draft needs an answer');
        dr.items[i] = { a, ...(n ? { note: n } : {}), ...(o.tuck ? { tuck: true } : {}) };
      }
    }
    if (!Object.keys(dr.items).length && !dr.notes.length) delete map.draft;
    return '';
  },
  send(map) {
    const dr = map.draft; if (!draftCount(map)) fail('nothing to send');
    for (const [i, x] of Object.entries(dr.items || {})) OPS.decision(map, { match: +i, answer: x.a, note: x.note || '', tuck: !!x.tuck, by: 'you' });
    for (const t of A(dr.notes)) OPS['now-add'](map, { t, by: 'you' });
    const n = draftCount(map); delete map.draft;
    // The handoff is what `bm wait` watches: it moves only when the owner sends, never on a draft or an agent edit.
    map.handoff = { rev: (map.rev || 0) + 1, n, at: new Date().toISOString() };
    return `You sent ${n} ${n === 1 ? 'answer' : 'answers'}`;
  }
};
const draftCount = m => m.draft ? Object.keys(m.draft.items || {}).length + A(m.draft.notes).length : 0;

// Log lines are [date, text, by, rev]. `by` is "you" for edits from the page, "agent" otherwise; `rev` lets
// an agent ask for only what changed since the revision it last read.
// An option is "Label", "Label|icon" or a leading "*" for the recommended one; objects pass through.
function parseOpt(x) {
  if (x && typeof x === 'object') return { l: String(x.l || '').slice(0, 40), ...(x.i ? { i: String(x.i) } : {}), ...(x.rec ? { rec: true } : {}) };
  let s = String(x).trim(); const rec = s.startsWith('*'); if (rec) s = s.slice(1);
  const [l, i] = s.split('|').map(v => v.trim());
  if (!l) fail('an option needs a label');
  return { l: l.slice(0, 40), ...(i ? { i } : {}), ...(rec ? { rec: true } : {}) };
}

function applyTo(map, op, rev) {
  if (!op || !OPS[op.op]) fail(`unknown op "${op && op.op}" (${Object.keys(OPS).join(', ')})`);
  const text = OPS[op.op](map, op);
  const line = op.quiet ? '' : (op.log || text);
  if (line) map.log = [[today(), String(line).slice(0, 200), op.by || 'agent', rev || (map.rev || 0) + 1], ...A(map.log)].slice(0, 30);
  map.updated = today();
  return map;
}

function apply(slug, op) { return applyMany(slug, [op]); }

// All-or-nothing: every op is applied to one copy under one lock, validated once, written once.
function applyMany(slug, ops) {
  if (!Array.isArray(ops) || !ops.length) fail('batch needs a non-empty array of ops');
  if (ops.length > 50) fail('batch is limited to 50 ops');
  return withLock(slug, () => {
    const map = read(slug), rev = (map.rev || 0) + 1;
    ops.forEach((op, i) => { try { applyTo(map, op, rev); } catch (err) { if (err instanceof BuildMapError && ops.length > 1) err.message = `op ${i + 1}: ${err.message}`; throw err; } });
    const errs = validate(map); if (errs.length) fail('invalid after change: ' + errs.join('; '));
    return write(slug, map);
  });
}

function create(slug, feature) {
  return withLock(slug, () => {
    if (fs.existsSync(file(slug))) fail(`map "${slug}" already exists`);
    const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'template.json'), 'utf8'));
    map.feature = feature || slug; map.updated = today(); map.log = [[today(), 'Map created']]; map.rev = 0;
    return write(slug, map);
  });
}

// Delete: the map file moves to the Trash and any cleanup the owner ticked is queued for an agent (`bm cleanup`).
function remove(slug, cleanup) {
  return withLock(slug, () => {
    const map = read(slug), want = A(cleanup).filter(x => ['branch', 'sessions'].includes(x));
    fs.mkdirSync(TRASH, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file(slug), path.join(TRASH, `build-map-${slug}-${stamp}.json`));
    if (want.length) {
      const q = cleanupList().filter(x => x.slug !== slug);
      q.push({ slug, feature: map.feature, branch: map.branch || '', what: want, at: today() });
      atomicWrite(CLEANUP(), JSON.stringify(q, null, 2) + '\n');
    }
    return { slug, cleanup: want };
  });
}
function cleanupList() { try { return A(JSON.parse(fs.readFileSync(CLEANUP(), 'utf8'))); } catch (e) { return []; } }
function cleanupDone(slug) {
  const q = cleanupList(), rest = q.filter(x => x.slug !== slug);
  if (rest.length === q.length) fail(`no cleanup waiting for "${slug}"`);
  if (rest.length) atomicWrite(CLEANUP(), JSON.stringify(rest, null, 2) + '\n'); else fs.rmSync(CLEANUP(), { force: true });
}

// A link may point at a local file (absolute or ~/ path in its url); the server shows those read-only.
function localPath(link) {
  const u = String((link || [])[2] || '');
  if (u.startsWith('~/')) return path.join(require('os').homedir(), u.slice(2));
  return path.isAbsolute(u) ? u : '';
}

module.exports = { STEPS, DIR, TRASH, localPath, remove, cleanupList, cleanupDone, draftCount, FLOW, KINDS, STAGES, STAGE_NAMES, CODES, DEPLOYS, RESULTS, BuildMapError, slugOk, file, list, read, write, apply, applyMany, applyTo, create, validate, today };
