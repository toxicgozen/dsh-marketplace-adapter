import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectSkillCandidates, normalizeConfig } from '../index.js';
const config = (overrides) => normalizeConfig(overrides);

test('host-specific frontmatter fields warn once instead of drifting silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-adapter-'));
  try {
    const mirrorPath = join(root, 'mirror');
    const skills = join(mirrorPath, 'plugins', 'gozen-stack', 'skills');
    for (const [name, frontmatter] of [
      ['typed', 'name: typed\ndescription: Typed work.\npaths: ["**/*.ts"]'],
      ['legacy', 'name: legacy\ndescription: Legacy toggles.\ndisableModelInvocation: true'],
      ['plain', 'name: plain\ndescription: Plain metadata.\nlicense: MIT'],
    ]) {
      await mkdir(join(skills, name), { recursive: true });
      await writeFile(join(skills, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`, 'utf8');
    }

    const warnings = [];
    const { candidates, complete } = await collectSkillCandidates(
      config({ mirrorPath }),
      { onWarning: (text) => warnings.push(text) },
    );

    assert.equal(complete, true);
    assert.deepEqual(candidates.map((candidate) => candidate.name), [
      'gozen-stack-legacy',
      'gozen-stack-plain',
      'gozen-stack-typed',
    ]);
    assert.equal(warnings.length, 2, warnings.join('\n'));
    assert.match(warnings.join('\n'), /"paths"/);
    assert.match(warnings.join('\n'), /"disableModelInvocation"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
