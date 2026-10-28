'use strict';
// The build panel's data (floorplan/assets/ui/60-build.js, model()) says what bm show says: the same stage,
// owner's notes, items waiting on the owner in their order, agent lines, modules, QA and counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmp, bm, REPO } = require('./helpers.cjs');
const { model } = require(path.join(REPO, 'skills', 'floorplan', 'assets', 'ui', '60-build.js'));

const read = (dir, slug) => ({ slug, map: JSON.parse(fs.readFileSync(path.join(dir, slug + '.json'), 'utf8')), health: [], warnings: [], code: { repo: null, map: false } });

/** What bm show prints, as the same fields the panel shows. */
function fromShow(out) {
  const lines = out.split('\n'), at = h => lines.indexOf(h);
  const block = (h) => { const i = at(h); if (i < 0) return []; const r = []; for (let j = i + 1; j < lines.length && /^ {2}/.test(lines[j]); j++) r.push(lines[j].trim()); return r; };
  return {
    stage: lines[0].match(/stage: (\S+)/)[1], rev: +lines[0].match(/rev (\d+)/)[1],
    notes: block('NOTES FROM YOU (open):'),
    waiting: block('Waiting on owner (their priority order):').map(l => +l.match(/^(\d+)\./)[1]),
    agent: lines.filter(l => /^(! blocked|→ next)/.test(l)).map(l => ({ blocked: l.startsWith('!') })),
    qa: (lines.find(l => l.startsWith('QA run ')) || '').match(/^QA run (\S+): (\d+)\/(\d+) pass(?:, (\d+) fail)?/),
    built: lines.find(l => l.startsWith('built ')).match(/built (\d+)\/(\d+) committed · sandbox (\d+) · prod (\d+)/).slice(1).map(Number),
  };
}

test('the panel shows what bm show shows', () => {
  const dir = tmp('panel');
  bm(dir, ['new', 'p', 'Panel', '--branch', 'feature/p', '--ticket', 'ADH-1', '--ticket', 'https://app.notion.com/p/abc']);
  bm(dir, ['mod-add', 'p', 'Apex', 'OrderService', '--code', 'committed', '--deployed', 'sandbox']);
  bm(dir, ['mod-add', 'p', 'LWC', 'orderSearch LWC', '--code', 'written']);
  bm(dir, ['decision-add', 'p', 'First question?', '--opt', '*Yes', '--opt', 'No']);
  bm(dir, ['decision-add', 'p', 'Need the API key', '--kind', 'input']);
  bm(dir, ['decision-add', 'p', 'Approve the plan', '--kind', 'approve', '--grill']);
  bm(dir, ['decision-add', 'p', 'Already settled', '--done', '--answer', 'Yes']);
  bm(dir, ['op', 'p', JSON.stringify({ op: 'order', ids: [2, 0, 1] })]);
  bm(dir, ['now-add', 'p', 'Building the search', '--who', 'agent 1']);
  bm(dir, ['now-add', 'p', 'Waiting on sandbox access', '--blocked', '--who', 'client']);
  bm(dir, ['op', 'p', JSON.stringify({ op: 'draft', match: 1, answer: 'Done' })]);
  bm(dir, ['op', 'p', JSON.stringify({ op: 'draft', t: 'Use the shared combobox' })]);
  bm(dir, ['op', 'p', JSON.stringify({ op: 'send' })]);
  bm(dir, ['qa-run', 'p', '--step', 'Loads:pass', '--step', 'Saves:fail:500 on save', '--step', 'Mobile:open', '--verdict', 'Not yet']);
  bm(dir, ['check', 'p', 'Validation deploy', 'pass', 'ok']);
  bm(dir, ['link', 'p', 'Spec', 'The spec', 'https://example.com/spec']);
  bm(dir, ['stage', 'p', 'qa']);

  const M = model(read(dir, 'p')), S = fromShow(bm(dir, ['show', 'p']).out);
  assert.equal(M.stage, S.stage); assert.equal(M.rev, S.rev);
  assert.deepEqual(M.steps.filter(s => s.state === 'now').map(s => s.k), ['qa']);
  assert.deepEqual(M.steps.filter(s => s.state === 'done').map(s => s.k), ['grill', 'spec', 'build']);
  // Notes from the owner: their sent notes, then answers they sent that the agent has not applied.
  assert.equal(M.inbox.notes.length + M.decisions.sent.length, S.notes.length);
  assert.deepEqual(M.inbox.notes.map(n => n.t), ['Use the shared combobox']);
  assert.deepEqual(M.decisions.sent.map(d => d.i), [1]);
  // Waiting on the owner, in their drag order.
  assert.deepEqual(M.decisions.open.map(d => d.i), S.waiting);
  assert.deepEqual(S.waiting, [2, 0]);
  assert.equal(M.forYou, S.waiting.length);
  assert.deepEqual(M.decisions.decided.map(d => d.i), [3]);
  assert.deepEqual(M.decisions.open.find(d => d.i === 2).opts.map(o => o.l), ['Approve', 'Hold'], 'an approve item offers Approve and Hold');
  assert.deepEqual(M.inbox.agent.map(n => ({ blocked: n.blocked })), S.agent);
  assert.deepEqual(M.inbox.agent.map(n => n.who), ['agent 1', 'client']);
  // QA, modules, deploy, tickets.
  const [, run, pass, total, fails] = S.qa;
  assert.deepEqual([String(M.qa[0].run), M.qa[0].pass, M.qa[0].steps.length, M.qa[0].fail], [run, +pass, +total, +(fails || 0)]);
  assert.equal(M.qa[0].verdict, 'Not yet');
  assert.deepEqual([M.built.committed, M.built.total, M.built.sandbox, M.built.prod], S.built);
  assert.deepEqual(M.modules.map(m => [m.layer, m.id, m.code, m.deployed]), [['Apex', 'OrderService', 'committed', 'sandbox'], ['LWC', 'orderSearch LWC', 'written', 'none']]);
  assert.deepEqual(M.deploy.checks, [{ name: 'Validation deploy', result: 'pass', note: 'ok' }]);
  assert.deepEqual(M.deploy.links.map(l => [l.label, l.text, l.url, l.local]), [['Spec', 'The spec', 'https://example.com/spec', false]]);
  assert.deepEqual(M.tickets, [{ label: 'ADH-1', url: '' }, { label: 'Notion', url: 'https://app.notion.com/p/abc' }]);
  // Activity, newest first, and the last send.
  assert.equal(M.activity[0].text, 'Stage set to QA');
  assert.equal(M.handoff.n, 2);
  assert.equal(M.draftCount, 0);
});

test('drafts show as not sent, and an archived map keeps the step it left', () => {
  const dir = tmp('panel2');
  bm(dir, ['new', 'a', 'Archived']);
  bm(dir, ['decision-add', 'a', 'Pick one', '--opt', 'A', '--opt', 'B']);
  bm(dir, ['stage', 'a', 'build']);
  bm(dir, ['op', 'a', JSON.stringify({ op: 'draft', match: 0, answer: 'B', note: 'why not' })]);
  bm(dir, ['op', 'a', JSON.stringify({ op: 'draft', t: 'a note' })]);
  bm(dir, ['stage', 'a', 'archive']);
  const M = model(read(dir, 'a'));
  assert.equal(M.draftCount, 2);
  assert.deepEqual(M.decisions.open[0].draft, { a: 'B', note: 'why not' });
  assert.deepEqual(M.inbox.drafts, ['a note']);
  assert.equal(M.forYou, 1, 'a draft is still waiting until it is sent');
  assert.equal(M.archived, true);
  assert.deepEqual(M.steps.filter(s => s.state === 'was').map(s => s.k), ['build']);
});

test('the panel lists only modules matched to the code map as on the graph', () => {
  const data = { slug: 'm', map: { feature: 'M', stage: 'build', layers: [{ name: 'Apex', mods: [{ id: 'OrderService', code: 'committed', deployed: 'none' }, { id: 'Gone', code: 'none', deployed: 'none' }] }] },
    code: { repo: 'shop', map: true, matches: { OrderService: { file: 'classes/OrderService.cls', node: 'apex' } } } };
  assert.deepEqual(model(data).modules.map(m => m.file), ['classes/OrderService.cls', '']);
});
