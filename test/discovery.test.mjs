import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSkillCandidates, MarketplaceAdapterProvider, normalizeConfig } from '../index.js';

test('a source without its own snapshot cannot read an automatically inferred legacy clone', async (t) => {
  const legacy = join(process.env.DSH_HOME, 'skill-mirrors', 'example-skills');
  const skill = join(legacy, 'plugins', 'old', 'skills', 'main-only');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: main-only\ndescription: Main branch content.\n---\nBody.');
  for (const ref of ['develop', 'release']) {
    const config = normalizeConfig({ url: 'example/skills', ref, syncOnApply: false });
    const provider = new MarketplaceAdapterProvider({ logger: { info() {}, warn() {} } }, config, { signal: new AbortController().signal, invalidate() {} });
    t.after(() => provider.dispose());
    assert.deepEqual(await provider.list(), { candidates: [], complete: false });
  }
  const explicit = normalizeConfig({ url: 'example/skills', ref: 'release', mirrorPath: legacy, syncOnApply: false });
  const observation = await collectSkillCandidates(explicit);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.candidates.map((candidate) => candidate.name), ['old-main-only']);
});

const SKILL = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

async function makeMirror() {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-adapter-'));
  const mirror = join(root, 'mirror');

  const alpha = join(mirror, 'plugins', 'alpha-stack');
  await mkdir(join(alpha, 'skills', 'one'), { recursive: true });
  await mkdir(join(alpha, 'skills', 'two'), { recursive: true });
  await mkdir(join(alpha, 'skills', 'bad'), { recursive: true });
  await writeFile(join(alpha, 'plugin.json'), JSON.stringify({ name: 'alpha-stack', version: '0.3.1' }));
  await writeFile(join(alpha, 'skills', 'one', 'SKILL.md'), SKILL('one', 'First skill.'));
  await writeFile(join(alpha, 'skills', 'two', 'SKILL.md'), SKILL('two', 'Second skill.', 'disable-model-invocation: true\n'));
  await writeFile(join(alpha, 'skills', 'bad', 'SKILL.md'), SKILL('Bad_Name', 'Invalid.'));
  await writeFile(join(alpha, 'skills', 'one', 'references.md'), 'reference body');

  const beta = join(mirror, 'plugins', 'beta-stack');
  await mkdir(join(beta, 'skills', 'one'), { recursive: true });
  await mkdir(join(beta, 'skills', 'three'), { recursive: true });
  await writeFile(join(beta, 'skills', 'one', 'SKILL.md'), SKILL('one', 'Other first skill.'));
  await writeFile(join(beta, 'skills', 'three', 'SKILL.md'), SKILL('three', 'Third skill.'));

  return { root, mirror };
}

test('namespaces every skill by its plugin directory', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const warnings = [];
  const config = normalizeConfig({ mirrorPath: mirror, namespace: 'plugin' });
  const { candidates, complete } = await collectSkillCandidates(config, { onWarning: (text) => warnings.push(text) });

  assert.equal(complete, true);
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ['alpha-stack-one', 'alpha-stack-two', 'beta-stack-one', 'beta-stack-three'],
  );
  assert.ok(warnings.some((text) => text.includes('Bad_Name')), 'invalid names are warned about, not thrown');
});

test('keeps the real directory as resource base and instruction path', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = normalizeConfig({ mirrorPath: mirror, namespace: 'plugin' });
  const { candidates } = await collectSkillCandidates(config);
  const one = candidates.find((candidate) => candidate.name === 'alpha-stack-one');

  assert.equal(one.resourceBase.kind, 'directory');
  assert.equal(one.resourceBase.path, join(mirror, 'plugins', 'alpha-stack', 'skills', 'one'));
  assert.equal(one.path, join(mirror, 'plugins', 'alpha-stack', 'skills', 'one', 'SKILL.md'));
  assert.equal(one.source, 'custom');
  assert.equal(one.provider, 'toxicgozen');
  assert.equal(one.metadata.plugin, 'alpha-stack');
  assert.equal(one.metadata.version, '0.3.1');
});

test('maps disable-model-invocation and can override it', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const strict = await collectSkillCandidates(normalizeConfig({ mirrorPath: mirror, namespace: 'plugin' }));
  assert.equal(strict.candidates.find((c) => c.name === 'alpha-stack-two').invocation.modelInvocable, false);

  const relaxed = await collectSkillCandidates(
    normalizeConfig({ mirrorPath: mirror, namespace: 'plugin', respectDisableModelInvocation: false }),
  );
  assert.equal(relaxed.candidates.find((c) => c.name === 'alpha-stack-two').invocation.modelInvocable, true);
});

test('falls back to plain names and lets the first plugin win a duplicate', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const warnings = [];
  const config = normalizeConfig({ mirrorPath: mirror, namespace: 'none' });
  const { candidates } = await collectSkillCandidates(config, { onWarning: (text) => warnings.push(text) });

  const ones = candidates.filter((candidate) => candidate.name === 'one');
  assert.equal(ones.length, 1);
  assert.equal(ones[0].metadata.plugin, 'alpha-stack');
  assert.ok(warnings.some((text) => text.includes('already claimed')));
});

test('only prefixes colliding names in collision mode', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = normalizeConfig({ mirrorPath: mirror, namespace: 'collision' });
  const { candidates } = await collectSkillCandidates(config);
  const names = candidates.map((candidate) => candidate.name);

  assert.ok(names.includes('alpha-stack-one'));
  assert.ok(names.includes('beta-stack-one'));
  assert.ok(names.includes('two'));
  assert.ok(names.includes('three'));
});

test('prefixes descriptions on request', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = normalizeConfig({ mirrorPath: mirror, namespace: 'plugin', descriptionPrefix: true });
  const { candidates } = await collectSkillCandidates(config);
  assert.equal(candidates.find((c) => c.name === 'alpha-stack-one').description, '[alpha-stack] First skill.');
});

test('honours include and exclude filters', async (t) => {
  const { root, mirror } = await makeMirror();
  t.after(() => rm(root, { recursive: true, force: true }));

  const onlyBeta = await collectSkillCandidates(
    normalizeConfig({ mirrorPath: mirror, namespace: 'plugin', plugins: { include: ['beta-stack'] } }),
  );
  assert.deepEqual(onlyBeta.candidates.map((c) => c.metadata.plugin), ['beta-stack', 'beta-stack']);

  const withoutBeta = await collectSkillCandidates(
    normalizeConfig({ mirrorPath: mirror, namespace: 'plugin', plugins: { exclude: ['beta-stack'] } }),
  );
  assert.ok(withoutBeta.candidates.every((c) => c.metadata.plugin === 'alpha-stack'));
});

test('reports an incomplete observation before the mirror exists', async () => {
  const missing = join(tmpdir(), 'marketplace-adapter-does-not-exist', 'mirror');
  const result = await collectSkillCandidates(normalizeConfig({ mirrorPath: missing }));
  assert.deepEqual(result, { candidates: [], complete: false });
});
