import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SYNC_TICK_MS,
  MarketplaceAdapterProvider,
  normalizeConfig,
  syncDueAt,
} from '../index.js';

function config(overrides = {}) {
  return normalizeConfig({ url: 'https://example.com/skills.tar.gz', mirrorPath: join(process.cwd(), 'test', '.tmp', 'mirror'), ...overrides });
}

function fakeContext() {
  const warnings = [];
  return {
    warnings,
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
  };
}

function fakeControl() {
  const control = {
    signal: new AbortController().signal,
    invalidated: 0,
    invalidate() {
      control.invalidated += 1;
    },
  };
  return control;
}

function fakeTimers() {
  const timers = {
    registered: [],
    cleared: [],
    setInterval(callback, delay) {
      const handle = { callback, delay };
      timers.registered.push(handle);
      return handle;
    },
    clearInterval(handle) {
      timers.cleared.push(handle);
    },
  };
  return timers;
}

function providerWith(mirror, overrides = {}) {
  const ctx = fakeContext();
  const control = fakeControl();
  const timers = fakeTimers();
  const now = { value: 1_000_000 };
  const provider = new MarketplaceAdapterProvider(ctx, config(overrides), control, {
    archive: { sync: async () => ({ revision: await mirror.sync(), root: config(overrides).mirrorPath }) },
    timers,
    now: () => now.value,
  });
  return { provider, ctx, control, timers, now };
}

test('the schedule is immediate first, then one interval after success', () => {
  const context = config({ syncIntervalMinutes: 60 });
  assert.equal(syncDueAt({ lastAttemptAt: 0, consecutiveFailures: 0 }, context), 0);
  assert.equal(syncDueAt({ lastAttemptAt: 1000, consecutiveFailures: 0 }, context), 1000 + 3_600_000);
});

test('failures retry with a bounded backoff instead of waiting the full interval', () => {
  const context = config({ syncIntervalMinutes: 60 });
  assert.equal(syncDueAt({ lastAttemptAt: 1000, consecutiveFailures: 1 }, context), 1000 + RETRY_BASE_MS);
  assert.equal(syncDueAt({ lastAttemptAt: 1000, consecutiveFailures: 2 }, context), 1000 + RETRY_BASE_MS * 2);
  assert.equal(syncDueAt({ lastAttemptAt: 1000, consecutiveFailures: 9 }, context), 1000 + RETRY_MAX_MS);
});

test('a zero interval or syncOnApply off disables scheduled work', () => {
  assert.equal(syncDueAt({ lastAttemptAt: 1000, consecutiveFailures: 0 }, config({ syncIntervalMinutes: 0 })), Infinity);
  assert.equal(syncDueAt({ lastAttemptAt: 0, consecutiveFailures: 0 }, config({ syncOnApply: false })), Infinity);
});

test('start schedules ticks and syncs immediately when due', async () => {
  let calls = 0;
  const mirror = { sync: async () => { calls += 1; return 'abc123'; } };
  const { provider, control, timers } = providerWith(mirror);

  provider.start();
  await provider.state.running;

  assert.equal(calls, 1);
  assert.equal(control.invalidated, 1);
  assert.equal(timers.registered.length, 1);
  assert.equal(timers.registered[0].delay, SYNC_TICK_MS);

  provider.dispose();
  assert.deepEqual(timers.cleared, [timers.registered[0]]);
});

test('a failed sync records the failure and retries after the backoff', async () => {
  let calls = 0;
  const mirror = {
    sync: async () => {
      calls += 1;
      throw new Error('mirror is unreachable');
    },
  };
  const { provider, ctx, now } = providerWith(mirror);

  provider.start();
  await provider.state.running;

  assert.equal(calls, 1);
  assert.equal(provider.state.consecutiveFailures, 1);
  assert.match(ctx.warnings.at(-1), /mirror is unreachable/);
  assert.match(ctx.warnings.at(-1), /retry/i);

  provider.runSyncIfDue(now.value + RETRY_BASE_MS - 1);
  assert.equal(calls, 1, 'not due yet');

  provider.runSyncIfDue(now.value + RETRY_BASE_MS);
  await provider.state.running;
  assert.equal(calls, 2);
  assert.equal(provider.state.consecutiveFailures, 2);
  provider.dispose();
});

test('a successful sync clears the failure streak and invalidates the catalog', async () => {
  let fail = true;
  const mirror = {
    sync: async () => {
      if (fail) throw new Error('offline');
      return 'def456';
    },
  };
  const { provider, control, now } = providerWith(mirror);

  provider.start();
  await provider.state.running;
  fail = false;
  provider.runSyncIfDue(now.value + RETRY_BASE_MS);
  await provider.state.running;

  assert.equal(provider.state.consecutiveFailures, 0);
  assert.equal(provider.state.lastSuccessAt, now.value);
  assert.equal(control.invalidated, 1, 'only the successful revision invalidates');
  provider.dispose();
});

test('a disposed provider stops scheduling and ignores further ticks', async () => {
  let calls = 0;
  const mirror = { sync: async () => { calls += 1; return 'abc'; } };
  const { provider, now } = providerWith(mirror);

  provider.start();
  await provider.state.running;
  provider.dispose();
  provider.runSyncIfDue(now.value + 60 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
});

test('zero interval never retries a failed startup and manual sync is single-flight', async () => {
  let finish;
  let calls = 0;
  const { provider, now, timers } = providerWith({ sync: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); } }, { syncIntervalMinutes: 0 });
  provider.start();
  const running = provider.runSync();
  assert.equal(running, provider.state.running);
  finish('revision');
  await running;
  provider.state.consecutiveFailures = 1;
  provider.runSyncIfDue(now.value + RETRY_MAX_MS * 2);
  assert.equal(calls, 1);
  assert.equal(timers.registered.length, 0);
  provider.dispose();
});

test('dispose during synchronization prevents invalidation', async () => {
  let finish;
  const { provider, control } = providerWith({ sync: () => new Promise((resolve) => { finish = resolve; }) });
  const running = provider.runSync();
  provider.dispose();
  finish('late');
  await running;
  assert.equal(control.invalidated, 0);
});

test('cleanup', async () => {
  await rm(join(process.cwd(), 'test', '.tmp'), { recursive: true, force: true });
});
