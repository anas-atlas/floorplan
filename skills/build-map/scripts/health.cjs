'use strict';
// A quick check of a map, in the spirit of Floorplan's Health panel: what on the map is wrong, stale or
// stuck, in plain words, worst first. It reads the map only; it never changes it.
const A = x => Array.isArray(x) ? x : [];
const DAY = 86400000;
const ACTIVE = ['grill', 'spec', 'build', 'qa', 'review', 'deploy'];
const ORDER = ['grill', 'spec', 'build', 'qa', 'review', 'deploy', 'quiz', 'close', 'complete'];
const daysSince = (d, now) => d ? Math.floor((now - Date.parse(d + 'T00:00:00')) / DAY) : Infinity;

/** [{ level: 'important' | 'worth' | 'minor', text }] */
function check(map, validate, now = Date.now()) {
  const out = [], add = (level, text) => out.push({ level, text });
  for (const p of validate ? validate(map) : []) add('important', `The map file has a problem: ${p}`);
  const mods = A(map.layers).flatMap(l => A(l.mods)), at = ORDER.indexOf(map.stage === 'plan' ? 'grill' : map.stage);
  const q = A(map.qa)[0], decs = A(map.plan && map.plan.decisions);
  if (at > ORDER.indexOf('build') && mods.some(m => m.code !== 'committed')) {
    const n = mods.filter(m => m.code !== 'committed').length;
    add('important', `At ${map.stage} with ${n} module${n > 1 ? 's' : ''} not committed`);
  }
  if (at > ORDER.indexOf('qa') && q && A(q.steps).some(s => s[1] !== 'pass')) add('important', `Past QA, but the last QA run still has ${A(q.steps).filter(s => s[1] === 'fail').length} fail and ${A(q.steps).filter(s => s[1] === 'open').length} open`);
  if (map.stage === 'complete' && mods.some(m => m.deployed !== 'prod') && mods.some(m => m.deployed === 'prod')) add('worth', `Complete, but ${mods.filter(m => m.deployed !== 'prod').length} module(s) are not in production`);
  const unapplied = decs.filter(d => !d.done && d.a && d.aBy === 'you');
  if (unapplied.length) add('important', `${unapplied.length} answer${unapplied.length > 1 ? 's' : ''} you sent ${unapplied.length > 1 ? 'are' : 'is'} not applied yet`);
  const idle = daysSince(map.updated, now);
  if (ACTIVE.includes(map.stage) && idle >= 7) add('worth', `No update for ${idle} days while at ${map.stage}`);
  const old = A(map.now).filter(n => n.by !== 'you' && !n.blocked && n.at && daysSince(n.at, now) >= 3);
  if (old.length) add('worth', `${old.length} "working on" line${old.length > 1 ? 's are' : ' is'} 3 or more days old`);
  if (['build', 'qa'].includes(map.stage) && mods.length && !mods.some(m => A(m.uses).length) && !A(map.actors).length) add('minor', 'No module links or actors, so the build diagram is empty');
  if (at >= ORDER.indexOf('build') && !mods.length) add('worth', `At ${map.stage} with no modules on the map`);
  const rank = { important: 0, worth: 1, minor: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

module.exports = { check };
