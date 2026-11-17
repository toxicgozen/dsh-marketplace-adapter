import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { collectSkillCandidates, normalizeConfig, SKILL_NAME } from '../index.js';

const CHECKOUT = process.env.SKILL_PLUGINS_REPO ?? 'C:\\Users\\10202\\Projects\\skills';
const MIRROR = join(CHECKOUT, 'plugins');

async function available() {
  try {
    await access(join(MIRROR, 'gozen-stack', 'skills'));
    return true;
  } catch {
    return false;
  }
}

test('discovers the real repository and leaves every relative link resolvable', async (t) => {
  if (!(await available())) {
    t.skip(`no checkout at ${CHECKOUT}`);
    return;
  }

  const warnings = [];
  const config = normalizeConfig({ mirrorPath: CHECKOUT, namespace: 'none' });
  const { candidates, complete } = await collectSkillCandidates(config, { onWarning: (text) => warnings.push(text) });

  assert.equal(complete, true);
  assert.ok(candidates.length >= 80, `expected the full skill set, found ${candidates.length}`);

  const names = new Set(candidates.map((candidate) => candidate.name));
  for (const expected of ['gozen-mode', 'code-review', 'ticktick-organize-tasks', 'blender-mode', 'nagare-mode']) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }

  // Nested automation skills are deliberately out of a plugin's direct skills root.
  assert.ok(!names.has('benny'), 'automation skills must not be discovered');

  for (const candidate of candidates) {
    assert.match(candidate.name, SKILL_NAME);
    assert.ok(candidate.description.length > 0);
    assert.equal(candidate.resourceBase.kind, 'directory');
    assert.equal(candidate.path, join(candidate.resourceBase.path, 'SKILL.md'));
    assert.equal((await stat(candidate.resourceBase.path)).isDirectory(), true);
  }

  // The whole point of the provider design: the authored tree is served as-is,
  // so every `../` reference — sibling skill, shared references, playbooks,
  // scripts — still resolves to a real file.
  let checked = 0;
  for (const candidate of candidates) {
    const body = (await readFile(candidate.path, 'utf8')).replace(/^---[\s\S]*?\n---\n/, '');
    for (const match of body.matchAll(/\]\((\.\.?\/[^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (target === '') continue;
      const absolute = resolve(dirname(candidate.path), decodeURIComponent(target));
      await access(absolute);
      checked += 1;
    }
  }
  assert.ok(checked >= 200, `expected the repository's relative links to be exercised, checked ${checked}`);
});

test('reports a model-invocable and a hidden subset', async (t) => {
  if (!(await available())) {
    t.skip(`no checkout at ${CHECKOUT}`);
    return;
  }

  const { candidates } = await collectSkillCandidates(normalizeConfig({ mirrorPath: CHECKOUT, namespace: 'none' }));
  const hidden = candidates.filter((candidate) => !candidate.invocation.modelInvocable);
  const visible = candidates.filter((candidate) => candidate.invocation.modelInvocable);

  assert.ok(hidden.length > 0, 'disable-model-invocation skills should stay hidden');
  assert.ok(visible.length > 0, 'some skills must remain model-invocable');
  assert.ok(hidden.every((candidate) => candidate.invocation.userInvocable), 'hidden skills stay user-invocable');
});
