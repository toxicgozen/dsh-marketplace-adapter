import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Config, collectSkillCandidates, normalizeBundleConfig, normalizeConfig, normalizeRepository } from '../index.js';

function config(mirrorPath) {
  return normalizeConfig({ repository: 'toxicgozen/skills', mirrorPath });
}

async function writePackage(root, relativeDir, name) {
  const dir = join(root, relativeDir, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nBody.\n`, 'utf8');
  return join(root, relativeDir);
}

async function manifest(root, relativePath, value) {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('schema item ref inherits the shared ref and only then defaults to HEAD', () => {
  const raw = Config({ ref: 'release', marketplaces: [{ url: 'example/one' }] });
  assert.equal(raw.marketplaces[0].ref, undefined);
  assert.equal(normalizeBundleConfig(raw).marketplaces[0].ref, 'release');
  assert.throws(() => Config({ tokenEnv: 'invalid-name' }));
});

test('root packages select their own skill directories and discovery alone may fall back to directory name', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePackage(root, '.', 'one');
  await writePackage(root, '.', 'two');
  await writeFile(join(root, 'skills/one/SKILL.md'), '---\ndescription: Directory fallback.\n---\nBody.');
  await manifest(root, '.codex-plugin/plugin.json', { version: '2.0' });
  await manifest(root, '.claude-plugin/marketplace.json', { plugins: [
    { name: 'first', source: './', skills: ['./skills/one'] },
    { name: 'second', source: { source: 'local', path: './' }, skills: ['./skills/two'] },
    { name: 'remote', source: { source: 'url', path: './' } },
    { name: 'git', source: { source: 'git-subdir', path: './' } },
  ] });
  const warnings = [];
  const { candidates } = await collectSkillCandidates(config(root), { onWarning: (text) => warnings.push(text) });
  assert.deepEqual(candidates.map((x) => x.name), ['first-one', 'second-two']);
  assert.equal(candidates[0].metadata.version, '2.0');
  assert.equal(warnings.filter((x) => /unsupported/.test(x)).length, 2);
});

test('the owner/repo shorthand becomes a GitHub URL and other values stay untouched', () => {
  assert.equal(normalizeRepository('toxicgozen/skills'), 'https://github.com/toxicgozen/skills');
  assert.equal(normalizeRepository('https://gitlab.example.com/team/skills.git'), 'https://gitlab.example.com/team/skills.git');
  assert.equal(normalizeRepository('git@github.com:toxicgozen/skills.git'), 'git@github.com:toxicgozen/skills.git');
  assert.equal(normalizeConfig({ repository: 'toxicgozen/skills' }).repository, 'https://github.com/toxicgozen/skills');
});

test('a marketplace manifest decides the package list and its directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await writePackage(root, 'packages/alpha', 'alpha-one');
    await writePackage(root, 'packages/beta', 'beta-one');
    await manifest(root, '.claude-plugin/marketplace.json', {
      name: 'sample',
      plugins: [
        { name: 'alpha', source: './packages/alpha' },
        { name: 'beta', source: { source: 'local', path: 'packages/beta' } },
      ],
    });

    const { candidates, complete } = await collectSkillCandidates(config(root));
    assert.equal(complete, true);
    assert.deepEqual(candidates.map((candidate) => candidate.name), [
      'alpha-alpha-one',
      'beta-beta-one',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package outside the mirror is ignored instead of read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await manifest(root, '.claude-plugin/marketplace.json', {
      name: 'sample',
      plugins: [{ name: 'escape', source: '../outside' }],
    });

    const warnings = [];
    const { candidates } = await collectSkillCandidates(config(root), { onWarning: (text) => warnings.push(text) });
    assert.deepEqual(candidates, []);
    assert.match(warnings.join('\n'), /outside the mirror/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unusable manifest warns and falls back to the plugins directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await writePackage(root, 'plugins/gamma', 'gamma-one');
    await manifest(root, '.claude-plugin/marketplace.json', { name: 'broken', plugins: 'not-an-array' });

    const warnings = [];
    const { candidates } = await collectSkillCandidates(config(root), { onWarning: (text) => warnings.push(text) });
    assert.deepEqual(candidates.map((candidate) => candidate.name), ['gamma-gamma-one']);
    assert.match(warnings.join('\n'), /no plugins array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the package filter applies to manifest package names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await writePackage(root, 'packages/alpha', 'alpha-one');
    await writePackage(root, 'packages/beta', 'beta-one');
    await manifest(root, '.claude-plugin/marketplace.json', {
      name: 'sample',
      plugins: [
        { name: 'alpha', source: './packages/alpha' },
        { name: 'beta', source: './packages/beta' },
      ],
    });

    const filtered = normalizeConfig({ mirrorPath: root, plugins: { include: ['beta'] } });
    const { candidates } = await collectSkillCandidates(filtered);
    assert.deepEqual(candidates.map((candidate) => candidate.name), ['beta-beta-one']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a flat repository becomes one named marketplace and shared fields reach each entry', () => {
  const single = normalizeBundleConfig({ repository: 'toxicgozen/skills' }).marketplaces;
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'toxicgozen-skills');
  assert.equal(single[0].providerName, 'toxicgozen-skills');
  assert.equal(single[0].repository, 'https://github.com/toxicgozen/skills');

  const many = normalizeBundleConfig({
    namespace: 'none',
    marketplaces: [
      { repository: 'toxicgozen/skills' },
      { name: 'work', repository: 'https://git.example.com/team/skills.tar.gz', ref: 'release' },
    ],
  }).marketplaces;

  assert.deepEqual(many.map((entry) => entry.name), ['toxicgozen-skills', 'work']);
  assert.equal(many[0].namespace, 'none', 'shared defaults reach each entry');
  assert.equal(many[1].ref, 'release');
  assert.equal(many[1].providerName, 'work');
  assert.notEqual(many[0].mirrorPath, many[1].mirrorPath, 'each marketplace owns its working copy');
});

test('invalid marketplace declarations are rejected before anything starts', () => {
  assert.throws(
    () => normalizeBundleConfig({ marketplaces: [{ name: 'a', repository: 'x/one' }, { name: 'a', repository: 'x/two' }] }),
    /duplicate marketplace name/,
  );
  assert.throws(() => normalizeBundleConfig({ marketplaces: [{ name: 'a' }] }), /requires a repository/);
  assert.throws(() => normalizeBundleConfig({ marketplaces: 'nope' }), /non-empty array/);
  assert.throws(
    () => normalizeBundleConfig({ marketplaces: [{ repository: 'x/one', providerName: 'runtime' }] }),
    /reserved/,
  );

  const fallback = normalizeBundleConfig({ marketplaces: [] }).marketplaces;
  assert.equal(fallback.length, 1, 'an empty list falls back to the single repository form');
  assert.equal(fallback[0].name, 'toxicgozen-skills');
});

test('the row schema defaults every field the settings form renders', () => {
  const value = Config({ marketplaces: [{ repository: 'owner/repo' }] });
  assert.equal(value.marketplaces[0].ref, undefined);
  assert.equal(value.namespace, 'plugin');
  assert.deepEqual(value.marketplaces[0].namespace, undefined);
  assert.equal(value.syncIntervalMinutes, 60);
  assert.equal(value.repository, 'https://github.com/toxicgozen/skills');
  assert.throws(() => Config({ namespace: 'bogus' }));
});
