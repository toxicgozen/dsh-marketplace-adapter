import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply, describeMarketplace, normalizeConfig } from '../index.js';

async function fixture(root) {
  const pkg = join(root, 'plugins', 'gozen-stack');
  for (const name of ['one', 'two']) {
    await mkdir(join(pkg, 'skills', name), { recursive: true });
    await writeFile(join(pkg, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nBody.\n`, 'utf8');
  }
  await writeFile(join(pkg, 'plugin.json'), JSON.stringify({ name: 'gozen-stack', version: '0.15.41' }), 'utf8');
  return root;
}

test('describeMarketplace reports package versions and skill counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await fixture(root);
    const config = normalizeConfig({ mirrorPath: root, syncOnApply: false });
    const { packages, complete } = await describeMarketplace(config);

    assert.equal(complete, true);
    assert.deepEqual(packages, [{ name: 'gozen-stack', version: '0.15.41', skills: 2 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply registers a marketplace command that reports repository, version and counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await fixture(root);
    const definitions = [];
    const ctx = {
      logger: { info() {}, warn() {} },
      get(name) {
        if (name !== 'commands') return undefined;
        return {
          register(definition) {
            definitions.push(definition);
            return () => {};
          },
        };
      },
      skills: {
        registerProvider(factory) {
          factory({ signal: new AbortController().signal, invalidate() {} });
          return () => {};
        },
      },
    };

    apply(ctx, { repository: 'toxicgozen/skills', mirrorPath: root, syncOnApply: false });

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, 'marketplace');
    assert.equal(definitions[0].input.hint, '[sync]');

    const result = await definitions[0].handler({
      commandId: 1,
      agent: { id: 'session' },
      rawInput: '',
      attachments: [],
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'success');
    assert.match(result.text, /github\.com\/toxicgozen\/skills\.git@main/);
    assert.match(result.text, /0\.15\.41/);
    assert.match(result.text, /2 skills/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the command rejects unknown input instead of syncing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await fixture(root);
    const definitions = [];
    const ctx = {
      logger: { info() {}, warn() {} },
      get: () => ({ register: (definition) => definitions.push(definition) }),
      skills: { registerProvider: (factory) => { factory({ signal: new AbortController().signal, invalidate() {} }); return () => {}; } },
    };

    apply(ctx, { mirrorPath: root, syncOnApply: false });
    const result = await definitions[0].handler({
      commandId: 1,
      agent: { id: 'session' },
      rawInput: 'remove everything',
      attachments: [],
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'error');
    assert.match(result.text, /usage: \/marketplace \[sync\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
