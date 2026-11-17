import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectSkillCandidates, normalizeConfig, normalizeRepository } from '../index.js';

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

test('the owner/repo shorthand becomes a GitHub URL and other values stay untouched', () => {
  assert.equal(normalizeRepository('toxicgozen/skills'), 'https://github.com/toxicgozen/skills.git');
  assert.equal(normalizeRepository('https://gitlab.example.com/team/skills.git'), 'https://gitlab.example.com/team/skills.git');
  assert.equal(normalizeRepository('git@github.com:toxicgozen/skills.git'), 'git@github.com:toxicgozen/skills.git');
  assert.equal(normalizeConfig({ repository: 'toxicgozen/skills' }).repository, 'https://github.com/toxicgozen/skills.git');
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
