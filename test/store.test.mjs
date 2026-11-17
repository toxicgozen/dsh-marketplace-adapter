import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';
import { spawn } from 'node:child_process';

test('independent processes serialize the whole read-modify-write transaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'store-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'store.json');
  const worker = join(dir, 'worker.mjs');
  await writeFile(worker, `import { updateMarketplaceStore } from ${JSON.stringify(new URL('../store.js', import.meta.url).href)};\nfor(let i=0;i<8;i++) await updateMarketplaceStore(process.argv[2], async (s) => { await new Promise(r=>setTimeout(r,2)); s.marketplaces.push({name:process.argv[3]+'-'+i,url:'https://github.com/example/skills'}); return {}; });`);
  const run = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, storePath, id], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
  });
  await Promise.all(['a', 'b', 'c'].map(run));
  const saved = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(new Set(saved.marketplaces.map((x) => x.name)).size, 24);
});

function command(storePath) {
  let definition;
  const providers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) { if (name === 'commands') return { register(value) { definition = value; } }; },
    skills: { registerProvider(factory) {
      const controller = new AbortController();
      providers.push(factory({ signal: controller.signal, invalidate() {} }));
      return () => controller.abort();
    } },
  };
  apply(ctx, { url: 'example/base', storePath, cachePath: join(storePath, '..', 'cache'), mirrorPath: join(storePath, '..', 'legacy'), syncOnApply: false });
  return { call: (rawInput) => definition.handler({ rawInput }), providers };
}

test('concurrent commands preserve every source and unchanged provider state', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'store.json');
  const { call, providers } = command(storePath);
  const initial = providers[0];
  initial.state.lastError = 'retained state';
  const results = await Promise.all(['a', 'b', 'c'].map((name) => call(`add example/${name} ${name}`)));
  assert.deepEqual(results.map((r) => r.kind), ['success', 'success', 'success']);
  const saved = JSON.parse(await readFile(storePath, 'utf8'));
  assert.deepEqual(saved.marketplaces.map((x) => x.name).sort(), ['a', 'b', 'c']);
  assert.equal(providers.filter((p) => p.name === initial.name).length, 1);
  assert.equal(initial.disposed, false);
});

test('remove matches only the final effective name', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'store.json');
  await writeFile(storePath, JSON.stringify({ version: 1, marketplaces: [{ name: 'custom', repository: 'example/two' }, { name: 'example-two', repository: 'example/three' }], removed: [] }));
  const { call } = command(storePath);
  assert.equal((await call('remove example-two')).kind, 'success');
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).marketplaces.map((x) => x.name), ['custom']);
});

test('a corrupt store refuses writes and retains original bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'store.json');
  await writeFile(storePath, '{broken');
  const { call } = command(storePath);
  assert.equal((await call('add example/new')).kind, 'error');
  assert.equal(await readFile(storePath, 'utf8'), '{broken');
});
