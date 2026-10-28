// Release hygiene: the plugin manifests, the README badge and the changelog agree on the version,
// so a release never ships half-bumped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SKILL, readJson } from './helpers.mjs';

const plugin = readJson(path.join(REPO, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(path.join(REPO, '.claude-plugin', 'marketplace.json'));
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// Atlas builds carry their own line on the upstream release they're built on, such as 0.1.5-atlas.1.
const badgeVersion = plugin.version.replaceAll('-', '--'); // shields.io writes a literal dash as two

test('the plugin version is a semantic version', () => {
  assert.match(plugin.version, /^\d+\.\d+\.\d+(-atlas\.\d+)?$/);
});

test('the marketplace lists this plugin, from this repo', () => {
  const entry = marketplace.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `marketplace.json lists ${plugin.name}`);
  assert.equal(entry.source, './');
});

test('the README version badge matches plugin.json', () => {
  assert.match(read('README.md'), new RegExp(`badge/version-${badgeVersion.replaceAll('.', '\\.')}-`));
});

test('the changelog has an entry for this version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${plugin.version.replaceAll('.', '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm'));
});

test('the skill has a name and description, and every file it points to exists', () => {
  const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: floorplan\ndescription: .{50,}/);
  for (const [, ref] of skill.matchAll(/\]\((references\/[\w.-]+\.md)/g)) assert.ok(fs.existsSync(path.join(SKILL, ref)), ref);
  for (const [, script] of skill.matchAll(/scripts\/(\w+\.mjs)/g)) assert.ok(fs.existsSync(path.join(SKILL, 'scripts', script)), script);
});
