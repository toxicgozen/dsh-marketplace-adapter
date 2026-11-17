import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../index.js';
import { ArchiveCache } from '../archive.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as tar from 'tar';

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

test('URL is the source identity and its default ref follows the remote default', () => {
  const config = normalizeConfig({ url: 'example/skills' });
  assert.equal(config.repository, 'https://github.com/example/skills');
  assert.equal(config.url, config.repository);
  assert.equal(config.ref, 'HEAD');
});
