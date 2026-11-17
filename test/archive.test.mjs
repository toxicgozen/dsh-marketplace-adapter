import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, MarketplaceAdapterProvider } from '../index.js';
import { ArchiveCache } from '../archive.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as tar from 'tar';
import { gzipSync } from 'node:zlib';

test('rejects traversal, absolute paths, links and special files before publishing', async (t) => {
  const { dir } = await fixture(t);
  for (const entry of [
    { path: '../escape', type: 'File' }, { path: '/absolute', type: 'File' },
    { path: 'C:/escape', type: 'File' }, { path: 'plugins/link', type: 'SymbolicLink', linkpath: '../outside' },
    { path: 'plugins/link', type: 'Link', linkpath: 'other' }, { path: 'plugins/pipe', type: 'FIFO' },
  ]) {
    const header = new tar.Header({ ...entry, size: 0, mode: 0o644 });
    header.encode();
    const bytes = gzipSync(Buffer.concat([header.block, Buffer.alloc(1024)]));
    const source = normalizeConfig({ url: 'http://localhost/attack.tar.gz', cachePath: dir });
    const cache = new ArchiveCache(source, { fetch: async () => new Response(bytes) });
    await assert.rejects(cache.sync(), /unsafe path|link or special/);
    assert.equal(await cache.current(), undefined);
  }
});

test('redirects strip tokens across origins and credentials resolve anew on every sync', async (t) => {
  const { dir, bytes } = await fixture(t);
  const seen = [];
  const target = await server(t, (req, res) => { seen.push(req.headers.authorization); res.end(bytes); });
  const originSeen = [];
  const origin = await server(t, (req, res) => { originSeen.push(req.headers.authorization); res.writeHead(302, { location: `${target}/repo.tar.gz` }); res.end(); });
  let token = 'first';
  const source = normalizeConfig({ url: `${origin}/repo.tar.gz`, cachePath: dir, tokenEnv: 'TEST_TOKEN' });
  const cache = new ArchiveCache(source, { resolveToken: async () => token });
  await cache.sync();
  token = 'second';
  await cache.sync();
  assert.deepEqual(originSeen, ['Bearer first', 'Bearer second']);
  assert.deepEqual(seen, [undefined, undefined]);
});

test('source identity isolates full URLs and refs, preserves a native plugins root, and coalesces same digest publication', async (t) => {
  const { dir } = await fixture(t);
  const file = join(dir, 'native.tar.gz');
  await tar.c({ file, gzip: true, cwd: join(dir, 'repo') }, ['plugins']);
  const bytes = await readFile(file);
  const make = (url, ref) => new ArchiveCache(normalizeConfig({ url, ref, cachePath: join(dir, 'cache') }), { fetch: async () => new Response(bytes) });
  const first = make('https://one.test/repo.tar.gz', 'main');
  const [a, b] = await Promise.all([first.sync(), make('https://one.test/repo.tar.gz', 'main').sync()]);
  assert.equal(a.root, b.root);
  assert.equal(await readFile(join(a.root, 'plugins/sample/skills/one/resource.txt'), 'utf8'), 'old resource');
  const c = await make('https://two.test/repo.tar.gz', 'main').sync();
  const d = await make('https://one.test/repo.tar.gz', 'release').sync();
  assert.equal(new Set([a.sourceKey, c.sourceKey, d.sourceKey]).size, 3);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'archive-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tree = join(dir, 'repo', 'plugins', 'sample', 'skills', 'one');
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, 'SKILL.md'), '---\nname: one\ndescription: Skill.\n---\nBody.');
  await writeFile(join(tree, 'resource.txt'), 'old resource');
  const file = join(dir, 'repo.tar.gz');
  await tar.c({ gzip: true, file, cwd: dir }, ['repo']);
  return { dir, bytes: await readFile(file) };
}

async function server(t, handler) {
  const instance = createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise((resolve) => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('downloads and publishes a complete immutable tree; failure keeps last-good and old resources', async (t) => {
  const { dir, bytes } = await fixture(t);
  let body = bytes;
  const url = await server(t, (_req, res) => res.end(body));
  const source = normalizeConfig({ url: `${url}/repo.tar.gz`, cachePath: join(dir, 'cache') });
  const cache = new ArchiveCache(source);
  const first = await cache.sync();
  assert.match(first.revision, /^sha256:[a-f0-9]{64}$/);
  const resource = join(first.root, 'plugins/sample/skills/one/resource.txt');
  assert.equal(await readFile(resource, 'utf8'), 'old resource');
  body = Buffer.from('broken archive');
  await assert.rejects(cache.sync());
  assert.deepEqual(await new ArchiveCache(source).current(), first);
  assert.equal(await readFile(resource, 'utf8'), 'old resource');
});

test('a broken local package declaration cannot replace the last-good snapshot', async (t) => {
  const { dir, bytes } = await fixture(t);
  let body = bytes;
  const cache = new ArchiveCache(normalizeConfig({ url: 'https://archive.test/repo.tar.gz', cachePath: join(dir, 'cache') }), { fetch: async () => new Response(body) });
  const first = await cache.sync();
  await mkdir(join(dir, 'repo/.claude-plugin'), { recursive: true });
  for (const entry of [{ name: 'missing', source: './missing' }, { name: 'outside', source: '../outside' }, { name: 'no-source' }]) {
    await writeFile(join(dir, 'repo/.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [entry] }));
    const archive = join(dir, 'bad.tar.gz');
    await tar.c({ file: archive, gzip: true, cwd: dir }, ['repo']);
    body = await readFile(archive);
    await assert.rejects(cache.sync(), /package/);
    assert.deepEqual(await cache.current(), first);
  }
});

test('provider switches root while old candidates and legacy resources remain readable', async (t) => {
  const { dir, bytes } = await fixture(t);
  let body = bytes;
  const tokens = [];
  const origin = await server(t, (req, res) => { tokens.push(req.headers.authorization); res.end(body); });
  const config = normalizeConfig({ url: `${origin}/repo.tar.gz`, mirrorPath: join(dir, 'repo'), cachePath: join(dir, 'cache'), syncOnApply: false, tokenEnv: 'WORK_TOKEN' });
  const filename = join(dir, 'repo/plugins/sample/skills/one/SKILL.md');
  await writeFile(filename, '---\ndescription: Directory fallback.\n---\nFirst body.');
  const file = join(dir, 'updated.tar.gz');
  await tar.c({ file, gzip: true, cwd: dir }, ['repo']);
  body = await readFile(file);
  let token = 'first-token';
  const ctx = { get(name) { if (name === 'credentials') return { resolve: async () => ({ value: token }) }; }, logger: { info() {}, warn() {} } };
  const provider = new MarketplaceAdapterProvider(ctx, config, { signal: new AbortController().signal, invalidate() {} });
  assert.equal(await provider.runSync(), true);
  const old = (await provider.list()).candidates[0];
  assert.equal((await provider.get(old)).content, 'First body.');
  await writeFile(filename, '---\nname: one\ndescription: Second.\n---\nSecond body.');
  await writeFile(join(dir, 'repo/plugins/sample/skills/one/resource.txt'), 'new resource');
  await tar.c({ file, gzip: true, cwd: dir }, ['repo']);
  body = await readFile(file);
  token = 'second-token';
  assert.equal(await provider.runSync(), true);
  const current = (await provider.list()).candidates[0];
  assert.notEqual(current.path, old.path);
  assert.equal((await provider.get(old)).content, 'First body.');
  assert.equal(await readFile(join(old.resourceBase.path, 'resource.txt'), 'utf8'), 'old resource');
  assert.equal(await readFile(join(current.resourceBase.path, 'resource.txt'), 'utf8'), 'new resource');
  assert.deepEqual(tokens, ['Bearer first-token', 'Bearer second-token']);
  const restart = new MarketplaceAdapterProvider(ctx, config, { signal: new AbortController().signal, invalidate() {} });
  assert.equal((await restart.list()).candidates[0].path, current.path);
  provider.dispose(); restart.dispose();
});

test('HTTP failures, timeouts, missing credentials and downgrade redirects reject safely', async (t) => {
  const { dir } = await fixture(t);
  const source = normalizeConfig({ url: 'https://archive.test/repo.tar.gz', cachePath: dir });
  const make = (fetch) => new ArchiveCache(source, { fetch });
  await assert.rejects(make(async () => new Response('secret body', { status: 403 })).sync(), /archive HTTP 403$/);
  await assert.rejects(make(async () => new Response('', { headers: { 'content-length': String(33 * 1024 * 1024) } })).sync(), /download size limit/);
  await assert.rejects(make(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x?signature=secret' } })).sync(), /requires HTTPS$/);
  await assert.rejects(new ArchiveCache({ ...source, tokenEnv: 'MISSING' }, { resolveToken: async () => undefined }).sync(), /credential MISSING is not configured/);
  const origin = await server(t, () => {});
  await assert.rejects(new ArchiveCache(normalizeConfig({ url: `${origin}/repo.tar.gz`, cachePath: dir, fetchTimeoutMs: 1000 })).sync(), /timed out/);
});

test('ambient GitHub tokens are ignored unless explicitly referenced', async (t) => {
  const { dir, bytes } = await fixture(t);
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  process.env.GITHUB_TOKEN = 'ambient-github'; process.env.GH_TOKEN = 'ambient-gh';
  try {
    let authorization;
    const cache = new ArchiveCache(normalizeConfig({ url: 'https://archive.test/repo.tar.gz', cachePath: dir }), { fetch: async (_url, init) => { authorization = init.headers.authorization; return new Response(bytes); } });
    await cache.sync();
    assert.equal(authorization, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('URL is the source identity and its default ref follows the remote default', () => {
  const config = normalizeConfig({ url: 'example/skills' });
  assert.equal(config.repository, 'https://github.com/example/skills');
  assert.equal(config.url, config.repository);
  assert.equal(config.ref, 'HEAD');
});
