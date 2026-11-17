import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  GitMirror,
  acquireMirrorLock,
  collectSkillCandidates,
  normalizeConfig,
} from '../index.js';

const quietLogger = { info() {}, warn() {} };

function config(overrides = {}) {
  return normalizeConfig({
    repository: 'https://example.com/skills.git',
    mirrorPath: join(process.cwd(), 'test', '.tmp', 'mirror'),
    ...overrides,
  });
}

function gitConfig(env) {
  const pairs = new Map();
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let index = 0; index < count; index += 1) {
    pairs.set(env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]);
  }
  return pairs;
}

function basic(token) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
}

async function withoutTokenEnv(run) {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('an environment token authenticates the mirror without running the token command', async () => {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    return { stdout: 'rev1\n', stderr: '' };
  };
  const mirror = new GitMirror(config(), quietLogger, exec);

  process.env.GITHUB_TOKEN = 'env-token';
  try {
    const revision = await mirror.sync();
    assert.equal(revision, 'rev1');
  } finally {
    delete process.env.GITHUB_TOKEN;
  }

  assert.equal(calls.filter((call) => call.file === 'gh').length, 0);
  assert.equal(gitConfig(calls[0].env).get('http.extraHeader'), basic('env-token'));
});

test('a failed token command is retried on the next sync instead of staying unresolved', async () => {
  let tokenCalls = 0;
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (file === 'gh') {
      tokenCalls += 1;
      if (tokenCalls === 1) throw new Error('gh: authentication required');
      return { stdout: 'recovered-token\n', stderr: '' };
    }
    return { stdout: 'rev\n', stderr: '' };
  };
  const mirror = new GitMirror(config({ tokenCommand: ['gh', 'auth', 'token'] }), quietLogger, exec);

  await withoutTokenEnv(async () => {
    await mirror.sync();
    assert.equal(tokenCalls, 1);
    assert.equal(gitConfig(calls[0].env).has('http.extraHeader'), false);

    await mirror.sync();
    assert.equal(tokenCalls, 2);
    assert.equal(gitConfig(calls.at(-1).env).get('http.extraHeader'), basic('recovered-token'));

    await mirror.sync();
    assert.equal(tokenCalls, 2, 'a resolved token is cached');
  });
});

test('an absent token command is settled once and not retried', async () => {
  let tokenCalls = 0;
  const exec = async (file) => {
    if (file === 'gh') {
      tokenCalls += 1;
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    }
    return { stdout: 'rev\n', stderr: '' };
  };
  const mirror = new GitMirror(config({ tokenCommand: ['gh', 'auth', 'token'] }), quietLogger, exec);

  await withoutTokenEnv(async () => {
    await mirror.sync();
    await mirror.sync();
  });

  assert.equal(tokenCalls, 1);
});

test('a schannel TLS failure retries once with the OpenSSL backend', async () => {
  const calls = [];
  let gitCalls = 0;
  const exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (file !== 'git') return { stdout: '', stderr: '' };
    gitCalls += 1;
    if (gitCalls === 1) throw new Error('schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS');
    return { stdout: 'rev\n', stderr: '' };
  };
  process.env.GITHUB_TOKEN = 'env-token';
  try {
    const mirror = new GitMirror(config({ sslBackend: 'auto' }), quietLogger, exec);
    await mirror.sync();
  } finally {
    delete process.env.GITHUB_TOKEN;
  }

  assert.equal(gitCalls, 2);
  assert.equal(gitConfig(calls.at(-1).env).get('http.sslBackend'), 'openssl');
});

test('the mirror lock keeps a second instance out and is released on demand', async () => {
  await rm(join(process.cwd(), 'test', '.tmp'), { recursive: true, force: true });
  const root = join(process.cwd(), 'test', '.tmp', 'lock');
  await mkdir(root, { recursive: true });
  const mirrorPath = join(root, 'mirror');

  const first = await acquireMirrorLock(mirrorPath);
  assert.ok(first, 'first acquisition succeeds');
  assert.equal(await acquireMirrorLock(mirrorPath), undefined, 'second acquisition is refused');

  await first.release();
  const second = await acquireMirrorLock(mirrorPath);
  assert.ok(second, 'the lock is reusable after release');
  await second.release();
});

test('a stale mirror lock is taken over', async () => {
  const root = join(process.cwd(), 'test', '.tmp', 'lock-stale');
  await mkdir(root, { recursive: true });
  const mirrorPath = join(root, 'mirror');
  await writeFile(`${mirrorPath}.lock`, JSON.stringify({ pid: 4242, at: Date.now() - 60 * 60_000 }), 'utf8');

  const lock = await acquireMirrorLock(mirrorPath);
  assert.ok(lock, 'a lock older than the stale window is reclaimed');
  await lock.release();
});

test('host-specific frontmatter fields warn once instead of drifting silently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-plugins-'));
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
