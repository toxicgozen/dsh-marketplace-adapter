import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readFile } from 'node:fs/promises';

import { STATUS_PATH, apply, describeMarketplaces, normalizeBundleConfig } from '../index.js';

async function fixture(root) {
  const pkg = join(root, 'plugins', 'gozen-stack');
  for (const name of ['one', 'two']) {
    await mkdir(join(pkg, 'skills', name), { recursive: true });
    await writeFile(
      join(pkg, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} skill.\n---\n\nBody.\n`,
      'utf8',
    );
  }
  await writeFile(join(pkg, 'plugin.json'), JSON.stringify({ name: 'gozen-stack', version: '0.15.41' }), 'utf8');
  return root;
}

function provider(config, state = {}) {
  return {
    config,
    warn() {},
    state: {
      running: undefined,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      consecutiveFailures: 0,
      lastError: undefined,
      revision: undefined,
      ...state,
    },
  };
}

test('the status route stays under the shared /api channel', () => {
  assert.equal(STATUS_PATH, '/api/marketplace-adapter/status');
});

test('the page reads the same route the Host registers', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const match = /const STATUS_PATH = '([^']+)'/.exec(source);
  assert.notEqual(match, null);
  assert.equal(`/${match[1]}`, STATUS_PATH);
});

test('the snapshot reports one marketplace per provider and keeps failures local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await fixture(root);
    const [declared] = normalizeBundleConfig({ repository: 'toxicgozen/skills', mirrorPath: root }).marketplaces;
    const [missing] = normalizeBundleConfig({
      marketplaces: [
        {
          repository: 'example/work',
          name: 'work',
          mirrorPath: join(root, 'not-synced-yet'),
        },
      ],
    }).marketplaces;

    const healthy = provider(declared, {
      revision: 'abcdef1234567',
      lastSuccessAt: Date.UTC(2024, 0, 2, 3, 4, 5),
      running: Promise.resolve(),
    });
    const broken = provider(missing, { lastError: 'fetch failed' });

    const snapshot = await describeMarketplaces({ providers: [healthy, broken], declared: [declared] });

    assert.equal(typeof snapshot.updatedAt, 'string');
    assert.equal(Number.isNaN(Date.parse(snapshot.updatedAt)), false);
    assert.equal(snapshot.marketplaces.length, 2);

    const [first, second] = snapshot.marketplaces;
    assert.equal(first.name, 'toxicgozen-skills');
    assert.equal(first.origin, 'config');
    assert.equal(first.revision, 'abcdef1234567');
    assert.equal(first.lastSync, '2024-01-02T03:04:05.000Z');
    assert.equal(first.syncing, true);
    assert.equal(first.complete, true);
    assert.deepEqual(first.packages, [{ name: 'gozen-stack', version: '0.15.41', skills: 2 }]);

    assert.equal(second.name, 'work');
    assert.equal(second.origin, 'store');
    assert.equal(second.revision, null);
    assert.equal(second.lastSync, null);
    assert.equal(second.lastError, 'fetch failed');
    assert.equal(second.syncing, false);
    assert.equal(second.complete, false);
    assert.deepEqual(second.packages, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Host registers one exact GET route that answers the page with JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-'));
  try {
    await fixture(root);

    let route;
    const ctx = {
      logger: { info() {}, warn() {} },
      get() {
        return undefined;
      },
      skills: {
        registerProvider(factory) {
          factory({ signal: new AbortController().signal, invalidate() {} });
          return () => {};
        },
      },
      inject(names, callback) {
        assert.deepEqual(names, ['connection']);
        callback({
          effect(factory) {
            return factory();
          },
          connection: {
            fetch: {
              register(definition) {
                route = definition;
                return () => {};
              },
            },
          },
        });
      },
    };

    apply(ctx, { repository: 'toxicgozen/skills', mirrorPath: root, syncOnApply: false });

    assert.equal(route.path, STATUS_PATH);
    assert.deepEqual(route.methods, ['GET']);

    const response = await route.fetch(new Request(`http://127.0.0.1:8631${STATUS_PATH}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.json();
    assert.equal(body.marketplaces.length, 1);
    assert.equal(body.marketplaces[0].name, 'toxicgozen-skills');
    assert.deepEqual(body.marketplaces[0].packages, [{ name: 'gozen-stack', version: '0.15.41', skills: 2 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
