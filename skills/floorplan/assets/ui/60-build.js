// Build map: when the build map server (skills/build-map) serves this viewer for a map, a Build panel shows the
// map from ~/build-maps (Inbox, stage strip, Decisions, QA, Deploy, modules, Activity), and the Feature lens
// lights up the map's modules on the code graph while the rest fades. Answers, notes and QA verdicts go back
// through the server's one write endpoint, which runs the same code as `bm`.
// Talks to the viewer only through window.Floorplan. Does nothing when the page has no window.BM (a repo's
// own floorplan/serve.mjs, or the map opened as a file). The data part also loads in Node for the tests.
(function () {
  const A = (x) => (Array.isArray(x) ? x : []);
  const FLOW = ['grill', 'spec', 'build', 'qa', 'review', 'deploy', 'quiz', 'close'];
  const STEPS = [...FLOW, 'complete'];
  const NAMES = { grill: 'Grill', spec: 'Spec', plan: 'Grill', build: 'Build', qa: 'QA', review: 'Review', deploy: 'Deploy', quiz: 'Quiz', close: 'Close', complete: 'Complete', archive: 'Archived' };
  // What an item offers when the agent gave no options (as on the classic page).
  const DEFAULT_OPTS = { approve: [{ l: 'Approve', rec: true }, { l: 'Hold' }], input: [{ l: 'Done', rec: true }], decision: [] };

  /** The step the map is at (an archived map: the step it left). */
  function curStep(map) {
    const s = map.stage === 'archive' ? map.was : map.stage;
    return s === 'plan' ? 'grill' : s === 'inputs' ? 'build' : STEPS.includes(s) ? s : 'grill';
  }
  // Older items have no short title: the first clause, cut to one line.
  function title(d) {
    if (d.short) return d.short;
    const s = String(d.t || '').split(/(?<=[.?!:])\s/)[0].replace(/:$/, '');
    return s.length > 64 ? s.slice(0, 62).replace(/\s+\S*$/, '') + '…' : s;
  }
  const stateOf = (d) => (d.done ? 'decided' : d.a && d.aBy === 'you' ? 'sent' : 'open');
  function ticket(t) {
    const s = String(t || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//.test(s)) return { label: s, url: '' };
    const host = (s.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
    return { label: /notion\./.test(host) ? 'Notion' : /github\./.test(host) ? 'GitHub' : /atlassian|jira/.test(host) ? 'Jira' : host.replace(/^www\./, ''), url: s };
  }

  /** Everything the panel shows, from the server's /api/map answer. Pure, so the tests can check it against `bm show`. */
  function model(data) {
    const map = data.map || {}, matches = (data.code && data.code.matches) || {}, draft = map.draft || {};
    const cur = curStep(map), archived = map.stage === 'archive', ci = STEPS.indexOf(cur);
    // Decisions in the owner's drag order (ord), then by when they were added: the order bm show lists them in.
    const decisions = A(map.plan && map.plan.decisions).map((d, i) => ({ ...d, i, kind: d.kind || 'decision' }))
      .sort((a, b) => (a.ord ?? 1e6 + a.i) - (b.ord ?? 1e6 + b.i))
      .map((d) => ({ i: d.i, t: String(d.t || ''), title: title(d), kind: d.kind, state: stateOf(d), opts: A(d.opts).length ? d.opts : DEFAULT_OPTS[d.kind] || [],
        ctx: d.ctx || '', grill: !!d.grill, step: d.step || '', a: d.a || '', aBy: d.aBy || '', note: d.note || '', tucked: !!d.tucked, draft: (draft.items || {})[d.i] || null }));
    const now = A(map.now).map((n, i) => ({ i, t: String(n.t || ''), who: n.who || '', at: n.at || '', step: n.step || '', blocked: !!n.blocked, by: n.by || '' }));
    const mods = A(map.layers).flatMap((l) => A(l.mods).map((m) => ({ layer: l.name, id: m.id, code: m.code, deployed: m.deployed, what: m.what || '', ticket: m.ticket || '',
      file: matches[m.id] ? matches[m.id].file : '' })));
    const qa = A(map.qa).map((r) => {
      const steps = A(r.steps).map((s) => ({ name: s[0], result: s[1], note: s[2] || '' }));
      return { run: r.run, when: r.when || '', env: r.env || '', plan: r.plan || '', verdict: r.verdict || '', steps,
        pass: steps.filter((s) => s.result === 'pass').length, fail: steps.filter((s) => s.result === 'fail').length, open: steps.filter((s) => s.result === 'open').length };
    });
    const links = A(map.deploy && map.deploy.links).map((l, i) => ({ i, label: l[0] || '', text: l[1] || l[0] || '', url: l[2] || '', local: /^(\/|~\/)/.test(l[2] || '') }));
    return {
      slug: data.slug, feature: map.feature || data.slug, stage: map.stage, archived, was: map.was || '', cur,
      steps: STEPS.map((k, i) => ({ k, name: NAMES[k], state: archived && k === cur ? 'was' : k === cur ? 'now' : i < ci ? 'done' : 'todo' })),
      rev: map.rev || 0, updated: map.updated || '', branch: map.branch || '', org: map.org || '',
      tickets: A(map.tickets).map(ticket).filter(Boolean),
      scope: (map.plan && map.plan.scope) || '',
      // Waiting on the owner: open items nobody answered yet (bm show's "Waiting on owner", bm list's "for you").
      forYou: decisions.filter((d) => d.state === 'open').length,
      inbox: {
        agent: now.filter((n) => n.by !== 'you'),
        notes: now.filter((n) => n.by === 'you'),
        drafts: A(draft.notes).map(String),
      },
      decisions: { open: decisions.filter((d) => d.state === 'open'), sent: decisions.filter((d) => d.state === 'sent'), decided: decisions.filter((d) => d.state === 'decided') },
      draftCount: Object.keys(draft.items || {}).length + A(draft.notes).length,
      qa, deploy: { checks: A(map.deploy && map.deploy.checks).map((c) => ({ name: c[0], result: c[1], note: c[2] || '' })), links },
      modules: mods,
      built: { total: mods.length, committed: mods.filter((m) => m.code === 'committed').length, sandbox: mods.filter((m) => m.deployed !== 'none').length, prod: mods.filter((m) => m.deployed === 'prod').length },
      activity: A(map.log).map((l) => ({ date: l[0] || '', text: String(l[1] || ''), by: l[2] || 'agent', rev: l[3] || 0 })),
      handoff: map.handoff || null,
      health: A(data.health), warnings: A(data.warnings),
      code: data.code || { repo: null, map: false },
    };
  }

  if (typeof module === 'object' && module.exports) { module.exports = { model, curStep, title, stateOf, ticket, STEPS, DEFAULT_OPTS }; return; }

  // ======================= the page =======================
  const SC = window.Floorplan, BM = window.BM;
  if (!SC || !BM || !BM.slug) return;
  const { h } = SC;
  const $ = (s) => document.querySelector(s);

  SC.icons.build = '<path d="M4 20h16"/><path d="M6 20V9l6-5 6 5v11"/><path d="M10 20v-5h4v5"/>';
  SC.icons.lens = '<circle cx="12" cy="12" r="3"/><path d="M2.5 12C4.8 7.6 8.1 5.5 12 5.5s7.2 2.1 9.5 6.5c-2.3 4.4-5.6 6.5-9.5 6.5S4.8 16.4 2.5 12z"/>';
  SC.icons.send = '<path d="M10 14 21 3"/><path d="M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3"/>';
  SC.icons.clock = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>';
  SC.icons.check = '<path d="M5 12l5 5L20 7"/>';
  SC.icons.note = '<path d="M8 9h8M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/>';
  SC.icons.alert = '<path d="M12 9v4M12 17h.01"/><path d="M10.4 3.9 2.6 17.5a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.6 3.9a1.8 1.8 0 0 0-3.2 0z"/>';

  const style = document.createElement('style');
  style.textContent = `
    :root { --bm: #8fb4ff; --bm-pass: #6fd7a8; --bm-fail: #f28b8b; --bm-open: #f0c36b; }
    #btn-build svg.i { color: var(--bm); }
    #btn-build .badge { background: var(--bm); color: #0b1424; }
    #btn-build.on { background: rgba(255, 255, 255, .07); color: var(--text); }
    .node { transition: opacity .35s var(--ease); }
    body.bm-lens .node.bm-dim { opacity: .16; }
    body.bm-lens .edges .edge.bm-dim { opacity: .1; }
    body.bm-lens .node.bm-lit .card { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--bm) 70%, transparent), var(--shadow-card); }
    .bm-tag { flex: none; margin-left: auto; font-size: 11px; font-weight: 600; line-height: 1; color: var(--bm); background: color-mix(in srgb, var(--bm) 14%, transparent); border-radius: 999px; padding: 4px 8px; white-space: nowrap; }
    body:not(.bm-lens) .bm-tag { display: none; }
    body.bm-nocode #ask, body.bm-nocode #search-btn, body.bm-nocode #flows-btn, body.bm-nocode #filters-btn, body.bm-nocode #btn-recent { display: none !important; }
    body.bm-nocode #empty { color: var(--text-3); line-height: 1.6; text-align: center; padding: 0 calc(var(--pw) + 24px) 0 24px; }
    .bm-root { padding-bottom: 8px; }
    .bm-root a { color: inherit; }
    .bm-top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .bm-top .kindlabel { font-size: 12.5px; color: var(--text-3); }
    .bm-top .ico { width: 26px; height: 26px; border-radius: 999px; display: grid; place-items: center; background: color-mix(in srgb, var(--bm) 16%, transparent); color: var(--bm); }
    .bm-top .ico svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .bm-top .btn { height: 30px; padding: 0 12px; font-size: 12.5px; margin-left: auto; }
    .bm-meta { color: var(--text-3); font-size: 12.5px; line-height: 1.6; display: flex; flex-wrap: wrap; gap: 4px 10px; }
    .bm-meta .mono { font-family: var(--mono); font-size: 11.5px; }
    .bm-tix { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .bm-tix a, .bm-tix span { font-size: 12px; color: var(--text-2); background: rgba(255, 255, 255, .06); border-radius: 999px; padding: 4px 10px; text-decoration: none; }
    .bm-tix a:hover { background: rgba(255, 255, 255, .1); color: var(--text); }
    .bm-steps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 14px; }
    .bm-step { font-size: 11.5px; padding: 4px 9px; border-radius: 999px; color: var(--text-4); background: rgba(255, 255, 255, .03); }
    .bm-step.done { color: var(--text-2); background: rgba(255, 255, 255, .06); }
    .bm-step.now { color: #0b1424; background: var(--bm); font-weight: 600; }
    .bm-step.was { color: var(--bm); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bm) 50%, transparent); }
    .bm-warn { margin-top: 12px; padding: 10px 12px; border-radius: 14px; background: rgba(242, 139, 139, .08); color: #f5c2c2; font-size: 12.5px; line-height: 1.5; }
    .bm-warn div + div { margin-top: 4px; }
    .bm-warn .lv { color: var(--text-3); margin-right: 6px; }
    .bm-it { border-radius: 14px; padding: 9px 10px; transition: background .15s var(--ease); }
    .bm-it:hover { background: rgba(255, 255, 255, .04); }
    .bm-it.draft { background: color-mix(in srgb, var(--bm) 7%, transparent); }
    .bm-ith { display: flex; align-items: flex-start; gap: 10px; width: 100%; background: none; border: 0; padding: 0; text-align: left; cursor: pointer; color: inherit; }
    .bm-ith .dot { margin-top: 6px; }
    .bm-ith .tt { flex: 1; min-width: 0; font-weight: 500; line-height: 1.45; }
    .bm-ith .val { font-size: 12px; color: var(--bm); white-space: nowrap; max-width: 40%; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .bm-sub { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin-top: 3px; }
    .bm-body { margin: 8px 0 0 18px; }
    .bm-body p { margin: 0 0 6px; color: var(--text-2); font-size: 12.5px; line-height: 1.55; }
    .bm-acts { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0 18px; align-items: center; }
    .bm-acts .btn, .bm-seg .btn { height: 28px; padding: 0 11px; font-size: 12px; background: rgba(255, 255, 255, .06); color: var(--text-2); }
    .bm-acts .btn:hover, .bm-seg .btn:hover { color: var(--text); background: rgba(255, 255, 255, .1); }
    .bm-acts .btn.rec { color: var(--text); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); }
    .bm-acts .btn.picked { background: var(--bm); color: #0b1424; box-shadow: none; }
    .bm-acts .btn.ghost { background: none; color: var(--text-3); }
    .bm-in { flex: 1; min-width: 120px; height: 32px; border-radius: 999px; border: 0; outline: none; background: rgba(255, 255, 255, .06); padding: 0 12px; color: var(--text); font-size: 12.5px; }
    .bm-in:focus { box-shadow: 0 0 0 1px rgba(255, 255, 255, .18); }
    .bm-compose { display: flex; gap: 6px; margin-top: 10px; }
    .bm-compose .btn { height: 32px; width: 32px; padding: 0; justify-content: center; background: rgba(255, 255, 255, .06); }
    .bm-line { display: flex; gap: 10px; padding: 7px 10px; border-radius: 12px; align-items: flex-start; }
    .bm-line svg.i { margin-top: 1px; color: var(--text-3); width: 15px; height: 15px; }
    .bm-line.blocked svg.i { color: var(--bm-fail); }
    .bm-line.mine svg.i { color: var(--bm); }
    .bm-line .tt { flex: 1; min-width: 0; line-height: 1.5; }
    .bm-line .who { font-size: 12px; color: var(--text-3); white-space: nowrap; margin-top: 1px; }
    .bm-line button.x { border: 0; background: none; color: var(--text-3); cursor: pointer; padding: 0 2px; }
    .bm-fold { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: none; color: var(--text-3); font-size: 12.5px; padding: 8px 10px; cursor: pointer; border-radius: 12px; }
    .bm-fold:hover { background: rgba(255, 255, 255, .04); color: var(--text-2); }
    .bm-fold::before { content: "▸"; font-size: 10px; transition: transform .2s var(--ease); }
    .bm-fold[aria-expanded="true"]::before { transform: rotate(90deg); }
    .bm-pill { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 3px 8px; white-space: nowrap; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
    .bm-run { color: var(--text-3); font-size: 12.5px; line-height: 1.5; margin: 0 0 8px; }
    .bm-run b { color: var(--text); font-weight: 500; }
    .bm-qs { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 12px; }
    .bm-qs:hover { background: rgba(255, 255, 255, .04); }
    .bm-qs .tt { flex: 1; min-width: 0; line-height: 1.45; }
    .bm-qs .bm-sub { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .bm-seg { display: flex; gap: 2px; flex: none; }
    .bm-seg .btn { height: 24px; padding: 0 8px; font-size: 11px; }
    .bm-seg .btn.on { color: #0f0f0f; background: var(--c); }
    .bm-mod { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 12px; }
    .bm-mod.hit { cursor: pointer; }
    .bm-mod.hit:hover { background: rgba(255, 255, 255, .06); }
    .bm-mod .tt { flex: 1; min-width: 0; }
    .bm-mod .rn { font-weight: 500; overflow-wrap: anywhere; }
    .bm-mod .rp { font-family: var(--mono); font-size: 11.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-mod .rp.none { font-family: var(--sans); color: var(--text-4); }
    .bm-lay { color: var(--text-4); font-size: 11.5px; margin: 8px 10px 2px; }
    .bm-act { display: grid; grid-template-columns: 74px 1fr; gap: 2px 10px; padding: 6px 10px; font-size: 12.5px; line-height: 1.5; }
    .bm-act .d { color: var(--text-4); font-variant-numeric: tabular-nums; }
    .bm-act .t { color: var(--text-2); }
    .bm-act.you .t { color: var(--text); }
    .bm-act .by { color: var(--bm); font-size: 11.5px; margin-left: 6px; }
    .bm-sendbar { position: sticky; bottom: 0; margin: 10px 12px 0; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 16px; border-radius: 999px; background: var(--raise-2); box-shadow: var(--shadow-float); }
    .bm-sendbar .tt { flex: 1; font-size: 12.5px; }
    .bm-sendbar .btn { height: 32px; padding: 0 12px; font-size: 12.5px; }
    .bm-sendbar .go { background: var(--bm); color: #0b1424; font-weight: 600; }
    .bm-empty { color: var(--text-4); font-size: 12.5px; padding: 4px 0 6px; }
    .bm-sum { padding: 12px 14px; border-radius: 16px; background: color-mix(in srgb, var(--bm) 7%, transparent); }
    .bm-sum .rw-tt { display: flex; gap: 9px; align-items: center; font-weight: 600; }
    .bm-sum .btn { height: 30px; padding: 0 12px; font-size: 12.5px; margin-top: 10px; background: rgba(255, 255, 255, .06); color: var(--text); }
    .bm-modnote { margin-top: 10px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--bm) 9%, transparent); font-size: 13px; line-height: 1.55; }
    .bm-modnote .hd { color: var(--bm); font-size: 11.5px; font-weight: 600; margin-bottom: 3px; }
  `;
  document.head.appendChild(style);

  const RES_C = { pass: 'var(--bm-pass)', fail: 'var(--bm-fail)', open: 'var(--bm-open)' };
  const RES_L = { pass: 'Pass', fail: 'Fail', open: 'Open' };
  const KIND_C = { decision: 'var(--bm)', input: 'var(--bm-open)', approve: 'var(--bm-pass)' };
  const STATE_C = { none: 'var(--text-4)', written: 'var(--bm-open)', committed: 'var(--bm)', sandbox: '#b49cff', prod: 'var(--bm-pass)' };
  const STATE_L = { none: 'Not built', written: 'Written', committed: 'Committed', sandbox: 'Sandbox', prod: 'Production' };
  const modState = (m) => (m.deployed === 'prod' ? 'prod' : m.deployed === 'sandbox' ? 'sandbox' : m.code);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  let data = null, M = null, showing = false, lensOn = !!SC.store.get('bm-lens', true);
  const ui = { exp: {} };
  const panelEl = () => document.getElementById('panel');
  if (!BM.codeMap) document.body.classList.add('bm-nocode');

  // ========== reading and writing ==========
  async function load() {
    try {
      const r = await fetch('/api/map/' + encodeURIComponent(BM.slug), { headers: { 'x-build-map-token': BM.token }, cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
    } catch (e) { SC.toast('Could not read the build map: ' + e.message); }
  }
  async function write(ops) {
    try {
      const r = await fetch('/api/map/' + encodeURIComponent(BM.slug) + '/write', { method: 'POST', headers: { 'content-type': 'application/json', 'x-build-map-token': BM.token }, body: JSON.stringify({ ops: [].concat(ops) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setData(j);
      return true;
    } catch (e) { SC.toast(e.message); return false; }
  }
  function setData(j) {
    data = j; M = model(j);
    document.title = `${M.feature} · build map`;
    // The Builds home marks maps that changed since you last opened them.
    try { const seen = JSON.parse(localStorage.getItem('bm.seen')) || {}; seen[BM.slug] = M.rev; localStorage.setItem('bm.seen', JSON.stringify(seen)); } catch (e) { /* storage blocked */ }
    badge();
    lens();
    if (showing) show(true);
  }

  // ========== header button ==========
  const btn = SC.addHeaderButton({ id: 'btn-build', label: 'Build', icon: 'build', title: 'The build map for this work', onClick: () => show() });
  const badgeEl = document.createElement('span');
  badgeEl.className = 'badge'; badgeEl.style.display = 'none';
  btn.appendChild(badgeEl);
  function badge() {
    badgeEl.style.display = M.forYou ? '' : 'none'; badgeEl.textContent = String(M.forYou);
    btn.title = M.forYou ? `${plural(M.forYou, 'item')} waiting on you` : 'The build map for this work';
  }

  // ========== the build panel ==========
  function show(keepScroll) {
    if (!M) return;
    const p = panelEl(), top = keepScroll && p ? p.scrollTop : 0;
    showing = true;
    SC.showPanel(`<div class="bm-root">${panelHTML()}</div>`, bind);
    if (top && p) p.scrollTop = top;
  }
  SC.on('panel', () => { showing = !!document.querySelector('#panel .bm-root'); btn.classList.toggle('on', showing); });

  const fold = (k, label, n, rows) => n ? `<button class="bm-fold" data-x="${k}" aria-expanded="${!!ui.exp[k]}">${h(label)} ${n}</button>${ui.exp[k] ? rows : ''}` : '';
  const sec = (name, count, inner) => `<div class="sec"><h3>${h(name)}${count !== '' && count != null ? ` <span class="c">${h(String(count))}</span>` : ''}</h3>${inner}</div>`;

  function headHTML() {
    const meta = [M.branch && `<span class="mono">${h(M.branch)}</span>`, M.org && h(M.org), `rev ${M.rev}`, M.updated && `updated ${h(M.updated)}`,
      M.code.repo ? (M.code.map ? `code map of ${h(M.code.repo)}` : `${h(M.code.repo)} has no code map yet`) : 'no code repo linked'].filter(Boolean);
    const tix = M.tickets.map((t) => (t.url ? `<a href="${h(t.url)}" target="_blank" rel="noopener">${h(t.label)}</a>` : `<span>${h(t.label)}</span>`)).join('');
    const probs = [...M.warnings.map((w) => ({ level: 'important', text: 'The map file has a problem: ' + w })), ...M.health.filter((x) => !M.warnings.some((w) => x.text.endsWith(w)) && !/build diagram/.test(x.text))];
    // (the classic page's build diagram is not part of this panel, so its health hint is left out)
    const st = M.code.stale;
    if (st && st.lags) probs.push({ level: 'worth', text: `The code map lags the branch: ${plural(st.files, 'file')} changed in ${plural(st.commits, 'commit')} since it was built. Ask Claude in the repo to update the floorplan.` });
    return `<div class="sec">
      <div class="bm-top"><span class="ico">${SC.icon('build')}</span><span class="kindlabel">Build map</span><a class="btn soft" href="/" title="All build maps">All builds</a></div>
      <h2 class="pt">${h(M.feature)}</h2>
      <div class="bm-meta">${meta.map((x) => `<span>${x}</span>`).join('')}</div>
      ${tix ? `<div class="bm-tix">${tix}</div>` : ''}
      <nav class="bm-steps" aria-label="Build steps">${M.steps.map((s) => `<span class="bm-step ${s.state}"${s.state === 'now' ? ' aria-current="step"' : ''}>${h(s.name)}</span>`).join('')}${M.archived ? '<span class="bm-step was">Archived</span>' : ''}</nav>
      ${probs.length ? `<div class="bm-warn">${probs.map((x) => `<div><span class="lv">${x.level === 'important' ? 'Important' : x.level === 'worth' ? 'Worth fixing' : 'Minor'}</span>${h(x.text)}</div>`).join('')}</div>` : ''}
    </div>`;
  }

  function inboxHTML() {
    const ib = M.inbox, n = ib.agent.length + ib.notes.length + ib.drafts.length;
    const agent = ib.agent.map((x) => `<div class="bm-line${x.blocked ? ' blocked' : ''}">${SC.iconI(x.blocked ? 'alert' : 'clock')}<span class="tt">${x.blocked ? '<b>Blocked:</b> ' : ''}${h(x.t)}</span>${x.who ? `<span class="who">${h(x.who)}</span>` : ''}</div>`).join('');
    const drafts = ib.drafts.map((t, i) => `<div class="bm-line mine">${SC.iconI('note')}<span class="tt">${h(t)} <span class="bm-sub">not sent yet</span></span><button class="x" data-dropnote="${i}" title="Remove note">✕</button></div>`).join('');
    const notes = ib.notes.map((x) => `<div class="bm-line mine">${SC.iconI('check')}<span class="tt">${h(x.t)}</span><span class="who">sent${x.at ? ' ' + h(x.at) : ''}</span></div>`).join('');
    return sec('Inbox', n || '', `${agent || drafts || notes ? '' : '<div class="bm-empty">Nothing in progress.</div>'}<div class="list">${agent}${drafts}</div>${fold('notes', 'Your notes, sent', ib.notes.length, `<div class="list">${notes}</div>`)}
      <form class="bm-compose" data-form="note"><input class="bm-in" name="t" maxlength="300" autocomplete="off" placeholder="Note for the agent"><button class="btn" title="Add note">${SC.iconI('check')}</button></form>`);
  }

  function openItem(d) {
    const k = 'd' + d.i, open = !!ui.exp[k], dr = d.draft;
    const pick = (o, oi) => `<button class="btn${o.rec ? ' rec' : ''}${dr && !dr.tuck && dr.a === o.l ? ' picked' : ''}" data-pick="${d.i}" data-o="${oi}">${h(o.l)}</button>`;
    const val = dr ? `<span class="val">${h(dr.tuck ? 'Set aside' : dr.a)}${dr.note ? ', note' : ''}</span>` : '';
    const body = open ? `<div class="bm-body">${d.title !== d.t ? `<p>${h(d.t)}</p>` : ''}${d.ctx ? `<p>${h(d.ctx)}</p>` : ''}</div>` : '';
    const noteBox = open || !d.opts.length ? `<form class="bm-acts" data-form="answer" data-i="${d.i}"><input class="bm-in" name="v" maxlength="500" autocomplete="off" placeholder="${d.opts.length ? 'Note' : 'Your answer'}" value="${h(dr ? (d.opts.length ? dr.note || '' : dr.tuck ? '' : dr.a) : '')}">${d.opts.length ? '' : `<button class="btn rec" title="Save">Save</button>`}</form>` : '';
    return `<div class="bm-it${dr ? ' draft' : ''}">
      <button class="bm-ith" data-x="${k}" aria-expanded="${open}"><i class="dot" style="background:${KIND_C[d.kind] || 'var(--bm)'}"></i><span class="tt">${h(d.title)}${d.grill ? ' <span class="bm-sub">grill</span>' : ''}${d.kind !== 'decision' ? ` <span class="bm-sub">${h(d.kind)}</span>` : ''}</span>${val}</button>
      ${body}
      ${d.opts.length ? `<div class="bm-acts">${d.opts.map(pick).join('')}<button class="btn ghost" data-tuck="${d.i}" title="Set it aside without choosing">Set aside</button>${dr ? `<button class="btn ghost" data-unpick="${d.i}" title="Clear your draft">Clear</button>` : ''}</div>` : dr ? `<div class="bm-acts"><button class="btn ghost" data-unpick="${d.i}">Clear</button></div>` : ''}
      ${noteBox}
    </div>`;
  }
  const answered = (d) => `<div class="bm-line">${SC.iconI(d.state === 'decided' ? 'check' : 'clock')}<span class="tt">${h(d.title)}<div class="bm-sub">${h(d.tucked ? 'Set aside' : d.a || 'Done')}${d.note ? ' · ' + h(d.note) : ''}</div></span>${d.state === 'sent' ? `<button class="x" data-undo="${d.i}" title="Take the answer back">Change</button>` : ''}</div>`;
  function decisionsHTML() {
    const D = M.decisions, all = D.open.length + D.sent.length + D.decided.length;
    return sec('Decisions', D.open.length ? `${D.open.length} for you` : all || '', `${M.scope ? `<p class="pd" style="font-size:12.5px;margin-bottom:8px">${h(M.scope)}</p>` : ''}
      ${D.open.length ? D.open.map(openItem).join('') : `<div class="bm-empty">${all ? 'Nothing waiting on you.' : 'No decisions on this map.'}</div>`}
      ${fold('sent', 'Sent, waiting for the agent', D.sent.length, `<div class="list">${D.sent.map(answered).join('')}</div>`)}
      ${fold('decided', 'Decided', D.decided.length, `<div class="list">${D.decided.map(answered).join('')}</div>`)}`);
  }

  function qaRun(r, live) {
    const steps = r.steps.map((s) => `<div class="bm-qs"><span class="tt">${h(s.name)}${s.note ? `<div class="bm-sub" title="${h(s.note)}">${h(s.note)}</div>` : ''}</span>${live
      ? `<span class="bm-seg">${['pass', 'fail', 'open'].map((v) => `<button class="btn${s.result === v ? ' on' : ''}" style="--c:${RES_C[v]}" data-qa="${h(String(r.run))}" data-step="${h(s.name)}" data-res="${v}" title="Mark ${RES_L[v]}">${RES_L[v]}</button>`).join('')}</span>`
      : `<span class="bm-pill" style="--c:${RES_C[s.result] || 'var(--text-3)'}">${h(RES_L[s.result] || s.result)}</span>`}</div>`).join('');
    return `<p class="bm-run"><b>Run ${h(String(r.run))}</b>${r.when ? ' · ' + h(r.when) : ''}${r.env ? ' · ' + h(r.env) : ''} · ${r.pass}/${r.steps.length} pass${r.fail ? `, ${r.fail} fail` : ''}${r.verdict ? `<br>${h(r.verdict)}` : ''}</p>${r.plan ? `<p class="bm-run">${h(r.plan)}</p>` : ''}<div class="list">${steps}</div>`;
  }
  function qaHTML() {
    if (!M.qa.length) return sec('QA', '', '<div class="bm-empty">No QA run yet.</div>');
    const [last, ...older] = M.qa;
    return sec('QA', last.fail ? `${last.fail} fail` : `${last.pass}/${last.steps.length}`, qaRun(last, true) + fold('qa-older', 'Earlier runs', older.length, older.map((r) => qaRun(r, false)).join('')));
  }

  function deployHTML() {
    const c = M.deploy.checks, l = M.deploy.links;
    if (!c.length && !l.length) return sec('Deploy', '', '<div class="bm-empty">No deploy checks or links yet.</div>');
    const link = (x) => x.local ? `<a href="/doc?map=${encodeURIComponent(M.slug)}&amp;i=${x.i}" target="_blank" rel="noopener">${h(x.text)}</a>`
      : /^https?:\/\//.test(x.url) ? `<a href="${h(x.url)}" target="_blank" rel="noopener">${h(x.text)}</a>` : h(x.text);
    return sec('Deploy', c.length ? `${c.filter((x) => x.result === 'pass').length}/${c.length}` : '',
      `<div class="list">${c.map((x) => `<div class="bm-qs"><span class="tt">${h(x.name)}${x.note ? `<div class="bm-sub" title="${h(x.note)}">${h(x.note)}</div>` : ''}</span><span class="bm-pill" style="--c:${RES_C[x.result] || 'var(--text-3)'}">${h(RES_L[x.result] || x.result)}</span></div>`).join('')}
      ${l.map((x) => `<div class="bm-line">${SC.iconI('open')}<span class="tt"><span class="bm-sub" style="margin:0">${h(x.label)}</span><div>${link(x)}</div></span></div>`).join('')}</div>`);
  }

  function modulesHTML() {
    if (!M.modules.length) return sec('Modules', '', '<div class="bm-empty">No modules on this map yet.</div>');
    const hits = M.modules.filter((m) => m.file).length, layers = [...new Set(M.modules.map((m) => m.layer))];
    const row = (m) => { const s = modState(m);
      return `<div class="bm-mod${m.file ? ' hit' : ''}"${m.file ? ` data-reveal="${h('f:' + m.file)}"` : ''}><i class="dot" style="background:${STATE_C[s]};margin-top:6px" title="${STATE_L[s]}"></i><span class="tt"><div class="rn">${h(m.id)}</div><div class="rp${m.file ? '' : ' none'}">${m.file ? h(m.file) : BM.codeMap ? 'no file by this name' : h(STATE_L[s])}</div></span><span class="bm-sub" style="margin:2px 0 0">${STATE_L[s]}</span></div>`; };
    const lensBtn = BM.codeMap && hits ? `<div class="actions" style="margin:0 0 8px"><button class="btn soft" data-lens>${SC.iconI('lens')}${lensOn ? 'Feature lens on' : 'Feature lens off'}</button><span class="bm-sub" style="align-self:center">${hits} of ${M.modules.length} on the code map</span></div>` : '';
    return sec('Modules', `${M.built.committed}/${M.built.total} committed · ${M.built.prod} prod`, lensBtn + layers.map((l) => `<div class="bm-lay">${h(l)}</div><div class="list">${M.modules.filter((m) => m.layer === l).map(row).join('')}</div>`).join(''));
  }

  function activityHTML() {
    const a = M.activity;
    const hand = M.handoff ? `<div class="bm-act you"><span class="d">${h(String(M.handoff.at || '').slice(0, 10))}</span><span class="t">Last send: ${plural(M.handoff.n || 0, 'answer')} at rev ${h(String(M.handoff.rev))}<span class="by">you</span></span></div>` : '';
    const rows = a.map((x) => `<div class="bm-act${x.by === 'you' ? ' you' : ''}"><span class="d">${h(x.date)}</span><span class="t">${h(x.text)}${x.by !== 'agent' ? `<span class="by">${h(x.by)}</span>` : ''}</span></div>`);
    return sec('Activity', a.length || '', hand + (rows.length ? rows.slice(0, 12).join('') + fold('act-more', 'Older', Math.max(0, rows.length - 12), rows.slice(12).join('')) : '<div class="bm-empty">Nothing logged yet.</div>'));
  }

  function sendBarHTML() {
    return M.draftCount ? `<div class="bm-sendbar" role="region" aria-label="Answers not sent yet"><span class="tt">${M.draftCount} ready to send</span><button class="btn" data-discard>Discard</button><button class="btn go" data-send>${SC.iconI('send')}Send</button></div>` : '';
  }
  const panelHTML = () => headHTML() + inboxHTML() + decisionsHTML() + qaHTML() + deployHTML() + modulesHTML() + activityHTML() + sendBarHTML();

  function bind(panel) {
    const root = panel.querySelector('.bm-root'); if (!root) return;
    root.addEventListener('click', (ev) => {
      const t = ev.target.closest('button, [data-reveal]'); if (!t || !root.contains(t)) return;
      const d = t.dataset;
      if (d.x) { ui.exp[d.x] = !ui.exp[d.x]; show(true); }
      else if (d.pick !== undefined) {
        const it = M.decisions.open.find((x) => x.i === +d.pick), o = it && it.opts[+d.o]; if (!o) return;
        const note = (root.querySelector(`form[data-i="${d.pick}"] input`) || {}).value || (it.draft && !it.draft.tuck ? it.draft.note || '' : '');
        write({ op: 'draft', match: it.i, answer: o.l, note: String(note).trim() });
      }
      else if (d.tuck !== undefined) write({ op: 'draft', match: +d.tuck, answer: 'Set aside', tuck: true });
      else if (d.unpick !== undefined) write({ op: 'draft', match: +d.unpick, clear: true });
      else if (d.dropnote !== undefined) write({ op: 'draft', dropNote: +d.dropnote });
      else if (d.undo !== undefined) write({ op: 'decision', match: +d.undo, answer: '' });
      else if (d.discard !== undefined) write({ op: 'draft', discard: true });
      else if (d.send !== undefined) write({ op: 'send' }).then((ok) => ok && SC.toast('Sent to the agent'));
      else if (d.qa !== undefined) write({ op: 'qa-step', run: d.qa, step: d.step, result: d.res });
      else if (d.lens !== undefined) { lensOn = !lensOn; SC.store.set('bm-lens', lensOn); lens(); show(true); }
      else if (d.reveal) SC.reveal(d.reveal);
    });
    root.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const f = ev.target, input = f.querySelector('input'), v = input.value.trim();
      if (f.dataset.form === 'note') { if (v) write({ op: 'draft', t: v }); return; }
      if (f.dataset.form === 'answer') {
        const it = M.decisions.open.find((x) => x.i === +f.dataset.i); if (!it || !v) return;
        // With options, Enter saves the note and keeps any option already picked; without, the text is the answer.
        const dr = it.draft;
        write(it.opts.length ? { op: 'draft', match: it.i, answer: dr && !dr.tuck ? dr.a : v, note: dr && !dr.tuck ? v : '' } : { op: 'draft', match: it.i, answer: v });
      }
    });
  }

  // ========== Feature lens: the map's modules light up on the graph, the rest fades ==========
  function lens() {
    const files = new Set(M ? M.modules.filter((m) => m.file).map((m) => 'f:' + m.file) : []);
    const on = lensOn && BM.codeMap && files.size > 0;
    document.body.classList.toggle('bm-lens', on);
    const chips = SC.state.chipEls, edges = SC.state.edgeEls;
    if (!chips) return;
    const holds = new Set(); // the parts that contain a module's file
    for (const f of files) for (const a of SC.exists(f) ? SC.chain(f) : []) holds.add(a);
    const lit = new Map();
    for (const [id, g] of chips) {
      g.querySelector('.bm-tag')?.remove();
      if (!on || id.startsWith('x:')) { g.classList.remove('bm-lit', 'bm-dim'); continue; }
      const key = id.startsWith('m:') ? 'f:' + id.slice(2) : id;
      let hit = holds.has(key) || (SC.exists(key) && SC.chain(key).some((a) => files.has(a)));
      if (!hit && key.startsWith('d:')) { const dir = key.slice(key.indexOf('|') + 1) + '/'; hit = [...files].some((f) => f.slice(2).startsWith(dir)); }
      lit.set(id, hit);
      g.classList.toggle('bm-lit', hit); g.classList.toggle('bm-dim', !hit);
      if (hit) {
        const n = files.has(key) ? 0 : [...files].filter((f) => SC.exists(f) && SC.chain(f).includes(key)).length;
        const head = g.querySelector('.card .head');
        if (head) { const tag = document.createElement('span'); tag.className = 'bm-tag'; tag.textContent = n ? `${n} in build` : 'Build'; head.appendChild(tag); }
      }
    }
    for (const x of edges ? edges.values() : []) {
      const dim = on && !(lit.get(x.e.a) !== false && lit.get(x.e.b) !== false);
      x.g.classList.toggle('bm-dim', dim);
    }
  }
  SC.on('render', () => {
    lens();
    if (!BM.codeMap) { const e = $('#empty'); if (e) { e.hidden = false; e.innerHTML = `${h(BM.feature)} has no code map.<br>${BM.repo ? `Ask Claude in ${h(BM.repo)}: make me a floorplan of this app.` : 'Link a repo with bm here inside it, then make a floorplan there.'}`; } }
  });

  // ========== where else the build shows ==========
  // The codebase panel: a short summary of the build, a click from the full panel.
  SC.addPanelSection('overview', () => M && {
    top: true,
    html: `<div class="sec"><div class="bm-sum"><div class="rw-tt"><span class="dot" style="background:var(--bm)"></span>${h(M.feature)}</div>
      <div class="bm-sub">At ${h(M.steps.find((s) => s.state === 'now' || s.state === 'was').name)}${M.forYou ? ` · ${plural(M.forYou, 'item')} for you` : ''} · ${M.built.committed}/${M.built.total} committed${M.qa[0] ? ` · QA ${M.qa[0].pass}/${M.qa[0].steps.length}` : ''}</div>
      <button class="btn" data-bm-open>${SC.iconI('build')}Open the build panel</button></div></div>`,
    bind: (el) => el.querySelector('[data-bm-open]')?.addEventListener('click', () => show()),
  });
  // A selected card that is one of the map's modules: its state on the build map.
  SC.addPanelSection('item', (id) => {
    if (!M) return '';
    const key = id.startsWith('m:') ? 'f:' + id.slice(2) : id;
    const mine = M.modules.filter((m) => m.file && 'f:' + m.file === key);
    if (!mine.length) return '';
    return { top: true, html: `<div class="sec">${mine.map((m) => `<div class="bm-modnote"><div class="hd">Build map · ${h(STATE_L[modState(m)])}</div>${h(m.id)}${m.what ? ` · ${h(m.what)}` : ''}</div>`).join('')}</div>` };
  });

  // ========== live: the map changes when an agent runs bm, or another tab answers ==========
  if (typeof EventSource !== 'undefined') {
    const es = new EventSource('/api/events?panel=1&token=' + encodeURIComponent(BM.token));
    let t = null;
    es.addEventListener('map', (ev) => { try { if (JSON.parse(ev.data).slug !== BM.slug) return; } catch (e) { return; } clearTimeout(t); t = setTimeout(load, 150); });
  }

  // The page opens on the build panel, unless the address points at a card. The first-visit tour (ui/40-tour.js)
  // would take the panel over, so it steps aside here; its "Start here" button still runs it.
  SC.on('ready', () => {
    if (new URLSearchParams(location.hash.slice(1)).get('s')) { load(); return; }
    load().then(() => show());
    let n = 0;
    const t = setInterval(() => {
      const tour = window.FloorplanTour;
      if (tour && tour.active()) { tour.end(); show(); clearInterval(t); } else if (++n > 15) clearInterval(t);
    }, 200);
  });
})();
