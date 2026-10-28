#!/usr/bin/env node
'use strict';
// Build map CLI for agents. Works with or without the server running; every command is one atomic edit.
const fs = require('fs');
const lib = require('./lib.cjs');
const repos = require('./repos.cjs');
const code = require('./code.cjs');

const HELP = `Build map CLI  (maps live in ~/build-maps/<name>.json, or BUILD_MAP_DIR)

  bm list [--all]                            archived maps only with --all
  bm show <map> [--since <rev>]              status; with --since, only what changed after that rev + notes from you
  bm new <map> "Feature name" [--branch B] [--org O] [--ticket T]...
  bm stage <map> grill|spec|build|qa|review|deploy|quiz|close|complete|archive
  bm mod <map> "<module>" [--code none|written|committed] [--deployed none|sandbox|prod] [--what ..] [--ticket ..] [--lane "Agent 1: import"] [--uses "A,B"] [--sub ".."] [--group ".."] [--rename "<new id>"]
  bm mod-add <map> "<layer>" "<module>" [--code ..] [--deployed ..] [--what ..] [--ticket ..] [--lane ..] [--uses ..] [--sub ..] [--group ..]
                  --lane names the agent building it; the Build view shows one lane per agent
                  --group "Intake" is the capability box the diagram draws around it (default: its --lane; "" clears)
                  --rename changes the id and every --uses and actor link that points at it
                  --uses "A,B" lists the module ids it calls or reads; the build diagram draws them as arrows ("" clears)
                  --sub "4 or 5 words" is the box subtitle in the diagram (default: the start of --what)
  bm actor <map> "<name>" [--uses "A,B"] [--remove]   who uses the build (Guest visitor, Staff user) and the modules they enter by
  bm now-add <map> "<text>" [--who X] [--blocked] [--step S]
                  only work in progress or a blocker, at most 5 agent lines; results and FYIs go to bm log
  bm now-done <map> <index|text>
  bm decision <map> <index|text> [--open|--done] [--answer ".."] [--note ".."]   toggles when no flag
  bm decision-add <map> "<question>" --short "2-4 words" --ctx "one line" [--kind decision|input|approve]
                  [--opt "*Recommended|icon"] [--opt "Other"]... [--grill] [--step S] [--done] [--answer ".."]
                  --step (grill, spec, build, qa, review, deploy, quiz, close) shows it in that step's view; inputs show in the Inbox at any step
                  options: up to 5, "*" marks the recommended one, "|icon" shows an icon button
                  (check, send, pause, link, x, mail, file, upload, eye, refresh, clock); --grill puts it in the Grill tab
  bm qa-run <map> --verdict ".." [--env E] [--plan URL] --step "name:pass|fail|open:note"...
  bm qa-step <map> "<step>" pass|fail|open [note] [--run N] [--verdict ..]
  bm check <map> "<name>" pass|fail|open [note]       production/deploy check
  bm link <map> "<label>" "<text>" [url or file path]   a local file opens read-only from the board
  bm scope <map> "<one sentence>"
  bm log <map> "<text>"
  bm wait <map> [--since <rev>] [--timeout <seconds>]
                  blocks until the owner presses Send on the page, then prints show and exits.
                  Run it in the background while you wait; with no --since it waits for the next send.
  bm cleanup                                 cleanup the owner asked for when deleting maps (branch, sessions)
  bm cleanup-done <map>                      clear one cleanup request once it is carried out
  bm batch <map> '<json array of ops>'       several edits, one atomic write ("-" reads the array from stdin)
  bm op <map> '<json op>'                    any single op, e.g. {"op":"stage","stage":"qa"}

Code (the repo's Floorplan map):
  bm here <map>                              link the map to the repo you are in (automatic when its branch is the map's branch)
  bm code <map>                              which modules match a file on the code map, and whether the code map lags the branch
  bm install-shim                            put a bm command in ~/.local/bin that runs this plugin's CLI

Every change adds a log line unless you pass --quiet. Use --log "text" to word it yourself.
Modules, Now items and decisions match by index or by a unique part of their text.
Edits are tagged "agent" in the log; set --by <name> or BM_BY to tag another writer.`;

function parse(argv) {
  const pos = [], flags = {}, multi = {};
  const bool = new Set(['blocked', 'open', 'done', 'quiet', 'all', 'grill', 'remove']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (bool.has(k)) flags[k] = true;
      else { const v = argv[++i]; if (v === undefined) throw new lib.BuildMapError(`--${k} needs a value`); (multi[k] = multi[k] || []).push(v); flags[k] = v; }
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

function show(slug, since) {
  const m = lib.read(slug), mods = (m.layers || []).flatMap(l => (l.mods || []).map(x => ({ ...x, layer: l.name })));
  const out = [`${m.feature}  [${slug}]  stage: ${m.stage}  rev ${m.rev || 0}  updated ${m.updated}`];
  if (m.handoff) out.push(`last send from owner: rev ${m.handoff.rev} (bm wait ${slug} --since ${m.handoff.rev} waits for the next one)`);
  if (m.branch) out.push(`branch ${m.branch}${m.org ? ' · ' + m.org : ''}${(m.tickets || []).length ? ' · ' + m.tickets.join(' ') : ''}`);
  const fromYou = (m.now || []).filter(n => n.by === 'you');
  // Open items in the owner's drag order (ord), then by when they were added.
  const decs = ((m.plan || {}).decisions || []).map((d, i) => ({ ...d, i })).sort((a, b) => (a.ord ?? 1e6 + a.i) - (b.ord ?? 1e6 + b.i));
  const answered = decs.filter(d => !d.done && d.a && d.aBy === 'you');
  const label = d => `${d.kind && d.kind !== 'decision' ? d.kind + ' ' : ''}${d.grill ? '[grill] ' : ''}${d.short && !d.t.startsWith(d.short) ? d.short + ': ' : ''}${d.t.length > 90 ? d.t.slice(0, 90) + '…' : d.t}`;
  if (since !== undefined) {
    const rev = +since, logs = (m.log || []).filter(l => (l[3] || 0) > rev);
    out.push(logs.length ? `Changes after rev ${rev}:` : `No logged changes after rev ${rev}.`);
    for (const l of logs) out.push(`  [${l[2] || 'agent'}] ${l[1]}`);
    if (rev < (m.rev || 0) && !logs.length) out.push('  (rev moved but nothing was logged: a --quiet edit or a hand edit; run show without --since)');
  }
  if (fromYou.length || answered.length) {
    out.push('NOTES FROM YOU (open):');
    for (const n of fromYou) out.push(`  * ${n.t}`);
    for (const d of answered) out.push(`  * Decision ${d.i} "${label(d)}": ${d.tucked ? 'set aside without an answer' : d.a}${d.note ? ' | note: ' + d.note : ''}   (apply, then: bm decision ${slug} ${d.i} --done)`);
  }
  if (since !== undefined) return out.join('\n');
  const waiting = decs.filter(d => !d.done && !(d.a && d.aBy === 'you'));
  if (waiting.length) { out.push('Waiting on owner (their priority order):'); for (const d of waiting) out.push(`  ${d.i}. ${label(d)}${(d.opts || []).length ? '  [' + d.opts.map(o => (o.rec ? '*' : '') + o.l).join(' / ') + ']' : ''}`); }
  for (const n of m.now || []) if (n.by !== 'you') out.push(`${n.blocked ? '! blocked' : '→ next   '}  ${n.t}${n.who ? ' (' + n.who + ')' : ''}`);
  for (const l of m.layers || []) {
    out.push(`${l.name}:`);
    for (const x of l.mods || []) out.push(`  ${x.id.padEnd(34)} ${x.code.padEnd(10)} ${x.deployed.padEnd(8)}${x.group || x.lane ? ' [' + (x.group || x.lane) + ']' : ''}`.trimEnd());
  }
  const q = (m.qa || [])[0];
  if (q) out.push(`QA run ${q.run}: ${q.steps.filter(s => s[1] === 'pass').length}/${q.steps.length} pass${q.steps.some(s => s[1] === 'fail') ? ', ' + q.steps.filter(s => s[1] === 'fail').length + ' fail' : ''} — ${q.verdict}`);
  out.push(`built ${mods.filter(x => x.code === 'committed').length}/${mods.length} committed · sandbox ${mods.filter(x => x.deployed !== 'none').length} · prod ${mods.filter(x => x.deployed === 'prod').length}`);
  const probs = lib.validate(m); if (probs.length) out.push('PROBLEMS: ' + probs.join('; '));
  return out.join('\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);
  const { pos, flags, multi } = parse(rest);
  const [slug, a, b, c] = pos;
  const by = flags.by || process.env.BM_BY || 'agent';
  const need = (...v) => { if (v.some(x => x === undefined)) throw new lib.BuildMapError(`missing argument. Run "bm help".`); };
  const wrap = op => { if (flags.log) op.log = flags.log; if (flags.quiet) op.quiet = true; op.by = op.by || by; return op; };
  const run = op => { const m = lib.apply(slug, wrap(op)); console.log(`ok · ${slug} rev ${m.rev}`); linkCode(slug, m, [op]); };

  switch (cmd) {
    case 'wait': {
      need(slug);
      const handoff = () => +((lib.read(slug).handoff || {}).rev || 0);
      const since = flags.since !== undefined ? +flags.since : handoff();
      const until = flags.timeout ? Date.now() + 1000 * +flags.timeout : Infinity;
      const tick = () => {
        let h; try { h = handoff(); } catch (err) { console.error('bm: ' + err.message); process.exit(1); }
        if (h > since) return console.log(`The owner sent answers (rev ${h}).\n` + show(slug));
        if (Date.now() > until) { console.log(`Nothing sent yet. Wait again: bm wait ${slug} --since ${since}`); process.exit(2); }
        setTimeout(tick, 2000);
      };
      return tick();
    }
    case 'cleanup': {
      const q = lib.cleanupList(); if (!q.length) return console.log('No cleanup waiting.');
      for (const x of q) console.log(`${x.slug}  "${x.feature}"  deleted ${x.at}  remove: ${x.what.map(w => w === 'branch' ? `branch ${x.branch || '(none)'} and its worktree` : 'sessions that worked on it').join(', ')}`);
      return console.log('Find the sessions by searching transcripts for the map name. Delete them with delete_session (the app asks the owner), delete a branch only if it is merged or the owner says so, then: bm cleanup-done <map>');
    }
    case 'cleanup-done': need(slug); lib.cleanupDone(slug); return console.log(`ok · cleanup for ${slug} cleared`);
    case 'list': { const l = lib.list().filter(x => flags.all || x.stage !== 'archive'); const cq = lib.cleanupList().length; if (cq) console.log(`CLEANUP WAITING: ${cq} deleted map${cq > 1 ? 's' : ''} (run bm cleanup)`); if (!l.length) return console.log('No maps yet. Create one: bm new <name> "Feature name"'); for (const x of l) console.log(x.error ? `${x.slug}  ERROR ${x.error}` : `${x.slug.padEnd(40)} ${String(x.stage).padEnd(8)} ${x.committed}/${x.total} committed · ${x.prod} prod · ${x.updated}`); return; }
    case 'show': need(slug); return console.log(show(slug, flags.since));
    case 'new': { need(slug); lib.create(slug, a);
      const m = flags.branch || flags.org || multi.ticket ? lib.apply(slug, { op: 'meta', branch: flags.branch, org: flags.org, tickets: multi.ticket, quiet: true, by }) : lib.read(slug);
      console.log(`created ${lib.file(slug)}`); return linkCode(slug, m, []); }
    case 'here': {
      need(slug); const m = lib.read(slug), root = repos.detect(m, process.cwd(), true);
      if (!root) throw new lib.BuildMapError('not inside a git repo: cd into the repo first');
      repos.remember(slug, root); const r = code.writeRecent(root, slug, m);
      return console.log(`ok · ${slug} is linked to ${root}${r ? ' · ' + r : ''}`);
    }
    case 'code': {
      need(slug); const m = lib.read(slug), root = repos.detect(m, process.cwd()) || repos.repoOf(slug), c = code.summary(m, root);
      if (!c.repo) return console.log(`No repo linked to ${slug} yet. Run bm here ${slug} inside its repo (automatic when the repo's branch is the map's branch).`);
      if (!c.map) return console.log(`${c.repo} (${c.branch}) has no code map yet. Ask Claude there: "make me a floorplan of this app".`);
      const mods = (m.layers || []).flatMap(l => l.mods || []);
      console.log(`${c.repo} (${c.branch}) · code map "${c.project}" built ${c.stale ? c.stale.builtAt : '?'}`);
      if (c.stale && c.stale.lags) console.log(`CODE MAP LAGS THE BRANCH: ${c.stale.files} file(s) changed in ${c.stale.commits} commit(s) since it was built${c.stale.builtBranch && c.stale.builtBranch !== c.stale.branch ? ` on ${c.stale.builtBranch}` : ''}. Update it with the floorplan skill.`);
      for (const x of mods) console.log(`  ${x.id.padEnd(34)} ${c.matches[x.id] ? c.matches[x.id].file : '(no file by this name)'}`);
      return;
    }
    case 'install-shim': return console.log(require('./shim.cjs').install());
    case 'stage': need(slug, a); return run({ op: 'stage', stage: a });
    case 'mod': need(slug, a); return run({ op: 'mod', id: a, code: flags.code, deployed: flags.deployed, what: flags.what, ticket: flags.ticket, lane: flags.lane, uses: flags.uses, sub: flags.sub, group: flags.group, rename: flags.rename });
    case 'mod-add': need(slug, a, b); return run({ op: 'mod-add', layer: a, id: b, code: flags.code, deployed: flags.deployed, what: flags.what, ticket: flags.ticket, lane: flags.lane, uses: flags.uses, sub: flags.sub, group: flags.group });
    case 'actor': need(slug, a); return run({ op: 'actor', name: a, uses: flags.uses, remove: !!flags.remove, quiet: true });
    case 'now-add': need(slug, a); return run({ op: 'now-add', t: a, who: flags.who, blocked: flags.blocked, step: flags.step });
    case 'now-done': need(slug, a); return run({ op: 'now-done', match: a });
    case 'decision': need(slug, a); return run({ op: 'decision', match: a, done: flags.done ? true : flags.open ? false : undefined, answer: flags.answer, note: flags.note });
    case 'decision-add': need(slug, a); return run({ op: 'decision', add: a, done: !!flags.done, answer: flags.answer, kind: flags.kind, short: flags.short, ctx: flags.ctx, opts: multi.opt, grill: !!flags.grill, step: flags.step });
    case 'qa-run': return run({ op: 'qa-run', env: flags.env, plan: flags.plan, verdict: flags.verdict, run: flags.run && +flags.run, steps: (multi.step || []).map(s => { const i = s.indexOf(':'), j = s.indexOf(':', i + 1); return j < 0 ? [s.slice(0, i), s.slice(i + 1), ''] : [s.slice(0, i), s.slice(i + 1, j), s.slice(j + 1)]; }) });
    case 'qa-step': need(slug, a, b); return run({ op: 'qa-step', step: a, result: b, note: c, run: flags.run, verdict: flags.verdict });
    case 'check': need(slug, a, b); return run({ op: 'check', name: a, result: b, note: c });
    case 'link': {
      need(slug, a, b);
      // A relative file path is stored absolute, so the board can open it from anywhere.
      const p = require('path'), url = c && !/^(https?:\/\/|~\/)/.test(c) && !p.isAbsolute(c) && fs.existsSync(c) ? p.resolve(c) : c;
      return run({ op: 'link', label: a, text: b, url });
    }
    case 'scope': need(slug, a); return run({ op: 'meta', scope: a, quiet: true });
    case 'log': need(slug, a); return run({ op: 'log', text: a });
    case 'batch': {
      need(slug, a);
      const ops = JSON.parse(a === '-' ? fs.readFileSync(0, 'utf8') : a);
      const all = (Array.isArray(ops) ? ops : [ops]).map(o => ({ by, ...o })), m = lib.applyMany(slug, all);
      console.log(`ok · ${slug} rev ${m.rev}`); return linkCode(slug, m, all);
    }
    case 'op': { need(slug, a); return run(JSON.parse(a)); }
    default: throw new lib.BuildMapError(`unknown command "${cmd}". Run "bm help".`);
  }
}

// After a write: remember the repo when we are in it, refresh its pointer block, and share the modules as recent work on its code map.
// This never fails the command: the map is already saved.
function linkCode(slug, map, ops) {
  try {
    const here = repos.detect(map, process.cwd()), notes = [];
    if (here) { const n = repos.remember(slug, here); if (n) notes.push(n); }
    const root = here || repos.repoOf(slug);
    if (root && (!ops.length || ops.some(o => ['mod', 'mod-add', 'stage', 'meta'].includes(o.op)))) { const r = code.writeRecent(root, slug, map); if (r) notes.push(r); }
    if (root && ops.some(o => o.op === 'stage')) repos.writePointer(root);
    if (notes.length) console.log('   ' + notes.join(' · '));
  } catch (err) { if (process.env.BM_DEBUG) console.error('bm: code link skipped: ' + err.message); }
}

try { main(); } catch (err) {
  if (err instanceof lib.BuildMapError || err instanceof SyntaxError) { console.error('bm: ' + err.message); process.exit(1); }
  throw err;
}
