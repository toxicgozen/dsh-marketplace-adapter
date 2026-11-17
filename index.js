/**
 * Downstream DSH adapter for a namespaced agent-plugin repository.
 *
 * The repository keeps its own layout (`plugins/<plugin>/skills/<skill>/SKILL.md`)
 * shared with Codex, Cursor, Claude Code and Pi. DSH's bundled filesystem
 * provider cannot read that layout: its roots are static, it scans one level
 * deep, and it takes a skill's identity from the frontmatter `name`, so it has
 * no notion of the owning plugin.
 *
 * This plugin closes the gap without touching the repository. It maintains a
 * Git mirror of the repository and registers one `ctx.skills` provider over it,
 * so names can be namespaced while every relative reference inside a skill
 * (`references/…`, `../<sibling>/SKILL.md`, `../../playbooks/…`) still resolves
 * against the real directory tree.
 *
 * @module dsh-marketplace-adapter
 */

import { readMarketplaceStore, readMarketplaceStoreSync, updateMarketplaceStore } from './store.js';
import { ArchiveCache, sourceIdentity } from './archive.js';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';


/** The public skill-name grammar enforced by `@deepseek-ai/dsh-skill`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_PROVIDER = 'toxicgozen';
const DEFAULT_REPOSITORY = 'https://github.com/toxicgozen/skills.git';
const DEFAULT_REF = 'HEAD';
const DEFAULT_RANK = 300;
/** Wall-clock cadence for the refresh check; the check itself is cheap. */
export const SYNC_TICK_MS = 15_000;
/** First retry delay after a failed sync; doubles per consecutive failure. */
export const RETRY_BASE_MS = 15_000;
/** Upper bound for the retry delay so a recovered host refreshes within minutes. */
export const RETRY_MAX_MS = 300_000;
/** A lock this old belongs to a dead process and may be reclaimed. */
/**
 * Frontmatter that other hosts act on but DSH ignores. Warning is the only
 * honest option: silently dropping them makes the same skill behave differently
 * per host with no visible signal.
 */
const HOST_SPECIFIC_FIELDS = Object.freeze([
  'paths',
  'globs',
  'allowed-tools',
  'allowed_tools',
  'argument-hint',
  'argumentHint',
  'disableModelInvocation',
  'modelInvocable',
  'userInvocable',
  'hooks',
  'context',
  'agent',
  'model',
]);
const NAMESPACES = Object.freeze(['none', 'collision', 'plugin']);

const MarketplaceEntry = z.object({
  name: z.string().description('Stable id; defaults to <owner>-<repo>'),
  url: z.string().description('GitHub HTTPS repository or direct HTTPS tar.gz URL'),
  repository: z.string().description('Compatibility alias for url'),
  tokenEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).description('Credential environment variable name'),
  cachePath: z.string().description('Immutable archive cache directory'),
  ref: z.string(),
  namespace: z.union(NAMESPACES).description('Skill-name prefix policy for this source'),
  mirrorPath: z.string().description('Working copy; defaults under the DSH home'),
  rank: z.number().description('Precedence among providers serving the same skill name'),
});

/**
 * The row's schema. Declaring it is what gives this bundle a settings form: the
 * Settings page renders these fields and writes them through the settings
 * service, so adding a marketplace never means hand-editing the profile patch.
 */
export const Config = z.object({
  marketplaces: z.array(MarketplaceEntry).default([]).description('Sources to adapt side by side'),
  repository: z.string().default(DEFAULT_REPOSITORY).description('One source, when marketplaces is empty'),
  ref: z.string().default(DEFAULT_REF).description('Branch or tag to follow'),
  namespace: z.union(NAMESPACES).default('plugin').description('Skill-name prefix policy'),
  descriptionPrefix: z.boolean().default(false).description('Prefix each description with the package name'),
  respectDisableModelInvocation: z.boolean().default(true),
  syncOnApply: z.boolean().default(true).description('Sync when the profile loads'),
  syncIntervalMinutes: z.number().default(60).description('Refresh interval after a successful sync; 0 disables it'),
  url: z.string().description('GitHub HTTPS repository or direct HTTPS tar.gz URL'),
  tokenEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).description('Credential environment variable name'),
  cachePath: z.string().description('Immutable archive cache directory'),
  mirrorPath: z.string().description('Default working copy for sources without one'),
  storePath: z.string().description('Where /marketplace add writes the sources it owns'),
  providerName: z.string().description('Provider name for the single repository form'),
  rank: z.number().default(DEFAULT_RANK),
  plugins: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }).description('Keep or drop packages by name'),
}).description('Adapts packaged skill marketplaces into DeepSeek Harness skills');

/**
 * Marketplace manifests a packaged skill repository may ship. They declare the
 * packages and their directories, so a repository is not required to look like
 * `plugins/<package>`; the directory scan is only the fallback.
 */
const MARKETPLACE_MANIFESTS = Object.freeze([
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
]);
const TRUTHY = new Set(['true', 'yes', 'on', '1']);
const FALSY = new Set(['false', 'no', 'off', '0']);

/** Declare the one optional service this row cannot work without. */
export const inject = ['skills'];

/**
 * Host plugin entry point.
 * @param ctx - the row's Cordis context.
 * @param config - the row's `config` object; see {@link normalizeConfig}.
 */
export function apply(ctx, config = {}) {
  const rawConfig = { ...config };
  const { marketplaces: declared } = normalizeBundleConfig(rawConfig);
  const storePath = declared[0].storePath;
  const mounted = [];
  let queue = Promise.resolve();
  const state = { providers: [], declared, storePath, refresh, normalizeStored,
    enqueue(work) { const next = queue.then(work); queue = next.catch(() => {}); return next; },
  };
  function normalizeStored(entries) { return entries.length ? normalizeBundleConfig({ ...rawConfig, marketplaces: entries }).marketplaces : []; }

  const initial = storedEntriesSync(ctx, storePath, rawConfig);
  mount(mergeMarketplaceSources(declared, initial.entries, initial.removed));
  registerMarketplaceCommand(ctx, state);
  registerStatusRoute(ctx, state);
  for (const provider of state.providers) provider.start();

  function mount(entries) {
    for (const entry of entries) {
      let provider;
      const disposer = ctx.skills.registerProvider((control) => {
        provider = new MarketplaceAdapterProvider(ctx, entry, control);
        return provider;
      });
      mounted.push({ disposer, provider, key: JSON.stringify(entry), name: entry.name });
    }
    state.providers = mounted.map((item) => item.provider);
    return state.providers;
  }

  /**
   * Rebuild the provider set from the declared entries plus the store the UI
   * writes. A changed marketplace is a different provider, because the skill
   * registry owns provider identity for the life of a registration.
   */
  async function refresh() {
    const { marketplaces: stored, removed } = await readMarketplaceStore(storePath);
    const entries = mergeMarketplaceSources(declared, normalizeStored(stored), removed);
    const keep = new Map(entries.map((entry) => [entry.name, JSON.stringify(entry)]));
    for (let i = mounted.length - 1; i >= 0; i -= 1) {
      const item = mounted[i];
      if (keep.get(item.name) === item.key) continue;
      item.provider.dispose();
      item.disposer?.();
      mounted.splice(i, 1);
    }
    for (const entry of entries) {
      if (mounted.some((item) => item.name === entry.name)) continue;
      mount([entry]);
      mounted.at(-1).provider.start();
    }
    state.providers = entries.map((entry) => mounted.find((item) => item.name === entry.name).provider);
    return state.providers;
  }
}

const MARKETPLACE_USAGE = 'usage: /marketplace [sync [name] | add <owner/repo> [name] | remove <name>]';

function storedEntriesSync(ctx, storePath, rawConfig) {
  try {
    const { marketplaces: stored, removed } = readMarketplaceStoreSync(storePath);
    const entries = stored.length === 0 ? [] : normalizeBundleConfig({ ...rawConfig, marketplaces: stored }).marketplaces;
    return { entries, removed };
  } catch (error) {
    ctx.logger.warn(`marketplace-adapter: stored marketplaces ignored: ${message(error)}`);
    return { entries: [], removed: [] };
  }
}

/**
 * One operation for both callers: the composer command and the settings tab run
 * the same handler, so the UI never reimplements what the command does.
 */
function registerMarketplaceCommand(ctx, state) {
  const commands = ctx.get('commands');
  if (commands === undefined) return;

  commands.register({
    name: 'marketplace',
    description: 'List, add, remove or resync the adapted marketplaces',
    input: { hint: '[sync [name] | add <owner/repo> [name] | remove <name>]' },
    async handler(invocation) {
      return state.enqueue(async () => {
      const [action, first, second] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);

      try {
        if (action === 'add') {
          if (first === undefined) return { kind: 'error', text: 'usage: /marketplace add <owner/repo> [name]' };
          return await addMarketplace(state, first, second);
        }
        if (action === 'remove') {
          if (first === undefined) return { kind: 'error', text: 'usage: /marketplace remove <name>' };
          return await removeMarketplace(state, first);
        }
        if (action === 'sync') {
          const targets = first === undefined ? state.providers : state.providers.filter((provider) => provider.config.name === first);
          if (targets.length === 0) return { kind: 'error', text: `marketplace: no marketplace named "${first}"` };
          const results = await Promise.all(targets.map((provider) => provider.runSync()));
          return { kind: results.every(Boolean) ? 'success' : 'error', text: await statusText(state) };
        }
        if (action !== undefined) return { kind: 'error', text: MARKETPLACE_USAGE };

        return { kind: 'success', text: await statusText(state) };
      } catch (error) {
        return { kind: 'error', text: `marketplace: ${message(error)}` };
      }
      });
    },
  });
}

async function statusText(state) {
  const blocks = [];
  for (const provider of state.providers) {
    const { packages, complete } = await describeMarketplace(provider.config, (text) => provider.warn(text));
    const origin = state.declared.some((entry) => entry.name === provider.config.name) ? 'cordis.patch.yml' : 'ui';
    blocks.push(`${renderMarketplace(provider, packages, complete)}\norigin       ${origin}`);
  }
  return blocks.join('\n\n');
}

async function addMarketplace(state, url, name) {
  const normalized = normalizeBundleConfig({ marketplaces: [{ url, ...(name === undefined ? {} : { name }) }] }).marketplaces[0];
  const result = await updateMarketplaceStore(state.storePath, (store) => {
    const declared = state.declared.some((entry) => entry.name === normalized.name);
    const exists = state.normalizeStored(store.marketplaces).some((entry) => entry.name === normalized.name);
    const removed = store.removed.includes(normalized.name);
    if ((declared || exists) && !removed) return { kind: 'error', text: `marketplace: "${normalized.name}" already exists`, changed: false };
    store.removed = store.removed.filter((entry) => entry !== normalized.name);
    if (!declared && !exists) store.marketplaces.push({ name: normalized.name, url: normalized.url, ref: normalized.ref });
    return { kind: 'success', text: `${removed ? 'restored' : 'added'} ${normalized.name}` };
  });
  if (result.kind === 'error') return result;
  await state.refresh();
  return { kind: 'success', text: `${result.text}\n\n${await statusText(state)}` };
}

async function removeMarketplace(state, name) {
  const result = await updateMarketplaceStore(state.storePath, (store) => {
    const declared = state.declared.some((entry) => entry.name === name);
    const normalized = state.normalizeStored(store.marketplaces);
    if ((!declared && !normalized.some((entry) => entry.name === name)) || store.removed.includes(name)) return { kind: 'error', text: `marketplace: no marketplace named "${name}"`, changed: false };
    store.marketplaces = store.marketplaces.filter((_entry, index) => normalized[index].name !== name);
    if (declared) store.removed.push(name);
    return { kind: 'success', text: `removed ${name}` };
  });
  if (result.kind === 'error') return result;
  await state.refresh();
  return { kind: 'success', text: `${result.text}\n\n${await statusText(state)}` };
}

function renderMarketplace(provider, packages, complete) {
  const config = provider.config;
  const state = provider.state;
  const lines = [
    `marketplace  ${config.name}  ${config.repository}@${config.ref}`,
    `revision     ${state.revision ?? 'not synced yet'}`,
    `last sync    ${state.lastSuccessAt === 0 ? 'never' : new Date(state.lastSuccessAt).toLocaleString()}`,
    `packages     ${packages.length}${complete ? '' : ' (mirror missing)'}`,
  ];
  if (state.lastError !== undefined) lines.push(`last error   ${state.lastError}`);

  if (packages.length > 0) {
    lines.push('');
    const width = Math.max(...packages.map((item) => item.name.length));
    for (const item of packages) {
      lines.push(`  ${item.name.padEnd(width)}  ${(item.version ?? '-').padEnd(10)} ${item.skills} skills`);
    }
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Client page                                                                */
/* -------------------------------------------------------------------------- */

/** Exact Fetch route the Client page reads; mounted under the Web carrier's shared `/api` channel. */
export const STATUS_PATH = '/api/marketplace-adapter/status';

/**
 * Serve the page's read model to the browser. The page is a plain global panel,
 * so it reads one JSON snapshot instead of a Remote service: this row has no
 * generated Typert contract, and a GET route keeps the client half dependency-free.
 * @param ctx - the row's Cordis context.
 * @param state - the row's mounted providers and the declarations behind them.
 */
function registerStatusRoute(ctx, state) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () =>
        scope.connection.fetch.register({
          path: STATUS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          async fetch() {
            const body = JSON.stringify(await describeMarketplaces(state));
            return new Response(body, {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            });
          },
        }),
      `marketplace-adapter: ${STATUS_PATH}`,
    );
  });
}

/**
 * Build the JSON the Client page renders. A failing marketplace is reported in
 * place with its reason instead of failing the whole snapshot, so one broken
 * mirror never hides the healthy ones.
 * @param state - the row's mounted providers and the declarations behind them.
 * @returns the snapshot the page's fetch returns.
 */
export async function describeMarketplaces(state) {
  const marketplaces = [];

  for (const provider of state.providers) {
    const entry = {
      name: provider.config.name,
      repository: provider.config.repository,
      ref: provider.config.ref,
      namespace: provider.config.namespace,
      origin: state.declared.some((declared) => declared.name === provider.config.name) ? 'config' : 'store',
      revision: provider.state.revision ?? null,
      lastSync: provider.state.lastSuccessAt === 0 ? null : new Date(provider.state.lastSuccessAt).toISOString(),
      lastError: provider.state.lastError ?? null,
      syncing: provider.state.running !== undefined,
      complete: false,
      packages: [],
    };

    try {
      const { packages, complete } = await describeMarketplace(provider.config, (text) => provider.warn(text));
      entry.complete = complete;
      entry.packages = packages.map((item) => ({
        name: item.name,
        version: item.version ?? null,
        skills: item.skills,
      }));
    } catch (error) {
      entry.lastError = entry.lastError ?? message(error);
    }

    marketplaces.push(entry);
  }

  return { updatedAt: new Date().toISOString(), marketplaces };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validate and default one row of `config`.
 * @param raw - the loader-supplied configuration object.
 * @returns the normalized configuration used everywhere else.
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('marketplace-adapter: config must be an object');
  }

  const repository = normalizeRepository(optionalString(raw.url) ?? optionalString(raw.repository) ?? DEFAULT_REPOSITORY);
  const ref = optionalString(raw.ref) ?? DEFAULT_REF;
  const mirrorPath = resolve(optionalString(raw.mirrorPath) ?? defaultMirrorPath(repository));

  const namespace = optionalString(raw.namespace) ?? 'plugin';
  if (!NAMESPACES.includes(namespace)) {
    throw new Error(`marketplace-adapter: namespace must be one of ${NAMESPACES.join(', ')} (got "${namespace}")`);
  }

  sourceIdentity(repository, ref);
  if (raw.tokenEnv !== undefined && (typeof raw.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.tokenEnv))) throw new Error('tokenEnv must be a POSIX environment variable name');

  const providerName = optionalString(raw.providerName) ?? DEFAULT_PROVIDER;
  if (providerName === 'runtime') {
    throw new Error('marketplace-adapter: providerName "runtime" is reserved by the skill registry');
  }

  return {
    repository,
    url: repository,
    tokenEnv: optionalString(raw.tokenEnv),
    ref,
    mirrorPath,
    cachePath: resolve(optionalString(raw.cachePath) ?? (optionalString(raw.mirrorPath) ? `${mirrorPath}.archives` : join(dirname(defaultStorePath()), 'snapshots'))),
    storePath: resolve(optionalString(raw.storePath) ?? defaultStorePath()),
    namespace,
    providerName,
    plugins: normalizePlugins(raw.plugins),
    descriptionPrefix: optionalBoolean(raw.descriptionPrefix, false),
    respectDisableModelInvocation: optionalBoolean(raw.respectDisableModelInvocation, true),
    syncOnApply: optionalBoolean(raw.syncOnApply, true),
    syncIntervalMinutes: optionalNumber(raw.syncIntervalMinutes, 60, 0),
    fetchTimeoutMs: optionalNumber(raw.fetchTimeoutMs, 180000, 1000),
    rank: optionalNumber(raw.rank, DEFAULT_RANK, 0),
  };
}

/**
 * Accept the `owner/repo` shorthand a marketplace URL field uses, and leave any
 * other value untouched so SSH and self-hosted URLs still work.
 * @param value - the configured repository.
 * @returns a Git URL.
 */export function normalizeRepository(value) {
  const text = String(value).trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? `https://github.com/${text}` : text;
}

/**
 * Resolve the bundle-level configuration into one entry per marketplace.
 *
 * `marketplaces` declares several sources side by side; a flat `repository` is
 * still accepted and becomes the single entry. Shared fields act as defaults for
 * every entry, while `mirrorPath` and `providerName` stay per-entry so two
 * marketplaces never share a working copy or a registry name.
 * @param raw - the loader-supplied configuration object.
 * @returns `{ marketplaces }`, each a normalized entry carrying `name` and `providerName`.
 */
export function normalizeBundleConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('marketplace-adapter: config must be an object');
  }

  const declared = raw.marketplaces;
  if (declared === undefined || (Array.isArray(declared) && declared.length === 0)) {
    const single = normalizeConfig(raw);
    const name = marketplaceName(single.repository);
    return { marketplaces: [{ ...single, name, providerName: optionalString(raw.providerName) ?? name }] };
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error('marketplace-adapter: marketplaces must be a non-empty array');
  }

  const shared = { ...raw };
  for (const key of ['marketplaces', 'url', 'repository', 'name', 'mirrorPath', 'cachePath', 'providerName']) delete shared[key];

  const seen = new Set();
  const marketplaces = declared.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`marketplace-adapter: marketplaces[${index}] must be an object`);
    }
    if (optionalString(entry.url) === undefined && optionalString(entry.repository) === undefined) {
      throw new Error(`marketplace-adapter: marketplaces[${index}] requires a repository or url`);
    }

    const normalized = normalizeConfig({ ...shared, ...entry });
    const name = optionalString(entry.name) ?? marketplaceName(normalized.repository);
    const providerName = optionalString(entry.providerName) ?? name;
    if (providerName === 'runtime') {
      throw new Error('marketplace-adapter: providerName "runtime" is reserved by the skill registry');
    }
    if (seen.has(name)) throw new Error(`marketplace-adapter: duplicate marketplace name "${name}"`);
    seen.add(name);

    return { ...normalized, name, providerName };
  });

  return { marketplaces };
}

/** `<owner>-<repo>` from a Git URL; the stable id shown in `/marketplace`. */
function marketplaceName(repository) {
  const tail = String(repository)
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '')
    .split(/[\\/:]+/)
    .filter((part) => part.length > 0)
    .slice(-2)
    .join('-');
  return slug(tail) || 'marketplace';
}

function normalizePlugins(value) {
  if (value === undefined || value === null) return { include: [], exclude: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('marketplace-adapter: plugins must be an object with optional include/exclude arrays');
  }
  return {
    include: stringArray(value.include, 'plugins.include'),
    exclude: stringArray(value.exclude, 'plugins.exclude'),
  };
}

function stringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`marketplace-adapter: ${field} must be an array of non-empty strings`);
  }
  return [...value];
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`marketplace-adapter: expected a boolean, got ${typeof value}`);
  return value;
}

function optionalNumber(value, fallback, minimum) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`marketplace-adapter: expected a number >= ${minimum}, got ${String(value)}`);
  }
  return value;
}

/**
 * `$DSH_HOME/skill-mirrors/<owner>-<repo>` — inside the DSH home so no other
 * agent harness ever reads it.
 * @param repository - the configured Git repository.
 * @returns the default mirror directory.
 */
export function defaultMirrorPath(repository) {
  const home = optionalString(process.env.DSH_HOME) ?? join(homedir(), '.dsh');
  const tail = String(repository)
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '')
    .split(/[\\/:]+/)
    .filter((part) => part.length > 0)
    .slice(-2)
    .join('-');
  const slug = tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return join(home, 'skill-mirrors', slug === '' ? 'skills' : slug);
}

/**
 * `$DSH_HOME/marketplace-adapter/marketplaces.json` — the list the settings UI
 * owns. It is separate from the profile patch: that file belongs to the user and
 * other bundles, and a plugin must not rewrite it to store its own data.
 * @returns the default store path.
 */
export function defaultStorePath() {
  const home = optionalString(process.env.DSH_HOME) ?? join(homedir(), '.dsh');
  return join(home, 'marketplace-adapter', 'marketplaces.json');
}

/**
 * Declared entries win over stored ones, and a tombstone removes a declared
 * entry without editing the profile patch: that file belongs to the user.
 */
export function mergeMarketplaceSources(declared, stored, removed = []) {
  const dropped = new Set(removed);
  const names = new Set();
  const merged = [];
  for (const entry of declared) {
    if (dropped.has(entry.name)) continue;
    names.add(entry.name);
    merged.push(entry);
  }
  for (const entry of stored) {
    if (names.has(entry.name) || dropped.has(entry.name)) continue;
    names.add(entry.name);
    merged.push(entry);
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Git mirror                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Owns the read-only Git working copy the provider serves skills from.
 *
 * It is a normal shallow clone, not a bare `--mirror` repository: the provider
 * needs a real working tree so skill resources keep their relative layout.
 * Nothing here commits, pushes, or writes into the checkout beyond `reset`.
 */
/** Delay before the next attempt after `failures` consecutive sync failures. */
export function backoffDelayMs(failures) {
  const exponent = Math.max(0, Math.min(failures - 1, 5));
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS);
}

/**
 * When the next refresh attempt is due.
 * @returns an epoch timestamp, `0` for "now", or `Infinity` when scheduling is off.
 */
export function syncDueAt(state, config) {
  if (!config.syncOnApply) return Infinity;
  if (!(state.lastAttemptAt > 0)) return 0;
  if (!(config.syncIntervalMinutes > 0)) return Infinity;
  if (state.consecutiveFailures > 0) return state.lastAttemptAt + backoffDelayMs(state.consecutiveFailures);
  if (!(config.syncIntervalMinutes > 0)) return Infinity;
  return state.lastAttemptAt + config.syncIntervalMinutes * 60_000;
}

/** Whether a refresh may start now. */
export function shouldSync(state, config, now) {
  if (state.running !== undefined) return false;
  return now >= syncDueAt(state, config);
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class MarketplaceAdapterProvider {
  constructor(ctx, config, control, deps = {}) {
    this.ctx = ctx;
    this.config = config;
    this.control = control;
    this.name = config.providerName;
    this.disposed = false;
    this.state = {
      running: undefined,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      consecutiveFailures: 0,
      lastError: undefined,
      revision: undefined,
    };
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? { setInterval, clearInterval };
    this.timer = undefined;
    this.archive = deps.archive ?? new ArchiveCache(config, {
      fetch: deps.fetch,
      resolveToken: async (name) => {
        const service = ctx.get?.('credentials');
        return service === undefined ? process.env[name] : (await service.resolve(name))?.value;
      },
    });
    try {
      const snapshot = this.archive.currentSync?.();
      if (snapshot) { this.config = { ...config, mirrorPath: snapshot.root }; this.state.revision = snapshot.revision; }
    } catch (error) { this.state.lastError = message(error); ctx.logger.warn(`marketplace-adapter: ${message(error)}`); }
    this.warned = new Set();
    control.signal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  /**
   * Own the refresh schedule. The catalog is cached by the skill registry, so a
   * provider that only refreshes from `list()` never refreshes a warm session.
   */
  start() {
    if (this.disposed || !this.config.syncOnApply) return;
    if (this.config.syncIntervalMinutes > 0) this.timer = this.timers.setInterval(() => this.runSyncIfDue(), SYNC_TICK_MS);
    this.timer?.unref?.();
    this.runSyncIfDue();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * `ctx.skills` provider discovery.
   * @param options - lookup options; only `signal` is used.
   * @returns candidate summaries, or an incomplete observation before the mirror exists.
   */
  async list(options = {}) {
    this.runSyncIfDue();
    return collectSkillCandidates(this.config, {
      provider: this.name,
      signal: options.signal,
      onWarning: (text) => this.warn(text),
    });
  }

  /**
   * Load one skill body from disk. Bodies are never cached, so an edit is
   * visible on the next load without a catalog change.
   * @param candidate - a candidate previously returned by {@link list}.
   * @returns the same summary plus the current body, or `undefined` if it vanished.
   */
  async get(candidate) {
    const file = typeof candidate.locator?.file === 'string' ? candidate.locator.file : candidate.path;
    if (typeof file !== 'string') return undefined;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isAbsent(error)) return undefined;
      throw error;
    }
    const parsed = parseSkillDocument(text, candidate.locator?.baseName);
    if (!parsed.ok) return undefined;
    return { ...candidate, content: parsed.skill.body };
  }

  warn(text) {
    const key = String(text);
    if (this.warned.has(key)) return;
    if (this.warned.size > 200) this.warned.clear();
    this.warned.add(key);
    this.ctx.logger.warn(`marketplace-adapter: ${key}`);
  }

  runSyncIfDue(now = this.now()) {
    if (this.disposed) return undefined;
    if (!shouldSync(this.state, this.config, now)) return this.state.running;
    return this.runSync();
  }

  runSync() {
    if (this.disposed) return undefined;
    if (this.state.running !== undefined) return this.state.running;
    const running = this.sync().finally(() => {
      this.state.running = undefined;
    });
    this.state.running = running;
    return running;
  }

  async sync() {
    this.state.lastAttemptAt = this.now();
    try {
      const snapshot = await this.archive.sync();
      if (this.disposed) return false;
      this.config = { ...this.config, mirrorPath: snapshot.root };
      this.state.lastSuccessAt = this.now();
      this.state.consecutiveFailures = 0;
      this.state.lastError = undefined;
      this.state.revision = snapshot.revision;
      this.control.invalidate();
      this.ctx.logger.info(`marketplace-adapter: ${this.config.name ?? this.name} snapshot ${snapshot.revision}`);
      return true;
    } catch (error) {
      this.state.consecutiveFailures += 1;
      this.state.lastError = message(error);
      const retry = this.config.syncIntervalMinutes > 0 ? `; retry in ${Math.round(backoffDelayMs(this.state.consecutiveFailures) / 1000)}s` : '';
      this.ctx.logger.warn(`marketplace-adapter: sync failed (${this.state.lastError})${retry}`);
      return false;
    } finally {
      this.state.lastAttemptAt = this.now();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Scan a mirror for skill packages and their `skills/<skill>/SKILL.md` entries.
 * @param config - a normalized configuration.
 * @param hooks - optional provider label, abort signal and warning sink.
 * @returns `{ candidates, complete }`; incomplete until the mirror first exists.
 */
export async function collectSkillCandidates(config, hooks = {}) {
  const provider = hooks.provider ?? config.providerName;
  const signal = hooks.signal;
  const onWarning = hooks.onWarning ?? (() => {});

  const { packages, complete } = await listPackages(config, onWarning);
  if (!complete) return { candidates: [], complete: false };

  const collected = [];
  for (const item of packages) {
    signal?.throwIfAborted?.();
    const plugin = item.name;
    const pluginDir = item.dir;
    const manifest = await readPluginManifest(pluginDir);
    const skillsDir = join(pluginDir, 'skills');

    let skillEntries;
    try {
      skillEntries = await readdir(skillsDir, { withFileTypes: true });
    } catch (error) {
      if (isAbsent(error)) {
        onWarning(`plugin "${plugin}" has no skills directory`);
        continue;
      }
      throw error;
    }

    const skillNames = skillEntries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();

    for (const entry of skillNames) {
      const skillDir = join(skillsDir, entry);
      const file = join(skillDir, 'SKILL.md');
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if (isAbsent(error)) continue;
        throw error;
      }
      const parsed = parseSkillDocument(text);
      if (!parsed.ok) {
        onWarning(`${plugin}/skills/${entry}/SKILL.md ignored: ${parsed.reason}`);
        continue;
      }
      for (const field of parsed.skill.unsupported) {
        onWarning(
          `${plugin}/skills/${entry}/SKILL.md uses "${field}", which DSH does not read; this skill behaves differently here`,
        );
      }
      collected.push({ plugin, manifest, skillDir, file, ...parsed.skill });
    }
  }

  const duplicates = new Map();
  for (const item of collected) duplicates.set(item.name, (duplicates.get(item.name) ?? 0) + 1);

  const claimed = new Map();
  const candidates = [];
  for (const item of collected) {
    const name = resolveSkillName(config, item, duplicates);
    if (!SKILL_NAME.test(name)) {
      onWarning(`${item.plugin}/skills/${item.name}/SKILL.md ignored: "${name}" is not a valid kebab-case skill name`);
      continue;
    }
    const owner = claimed.get(name);
    if (owner !== undefined) {
      onWarning(`skill "${name}" from ${item.plugin} ignored because ${owner} already claimed it`);
      continue;
    }
    claimed.set(name, item.plugin);

    candidates.push({
      name,
      description: config.descriptionPrefix ? `[${item.plugin}] ${item.description}` : item.description,
      ...(item.whenToUse === undefined ? {} : { whenToUse: item.whenToUse }),
      invocation: config.respectDisableModelInvocation
        ? item.invocation
        : { ...item.invocation, modelInvocable: true },
      source: 'custom',
      provider,
      rank: config.rank,
      locator: { file: item.file, plugin: item.plugin, skillDir: item.skillDir, baseName: item.name },
      path: item.file,
      resourceBase: { kind: 'directory', path: item.skillDir },
      metadata: {
        plugin: item.plugin,
        ...(item.manifest?.version === undefined ? {} : { version: item.manifest.version }),
      },
    });
  }

  candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { candidates, complete };
}

/**
 * Packages declared by a marketplace manifest, or the `plugins/` directory when
 * the repository ships none. A manifest that cannot be used warns and falls back,
 * so a broken manifest never empties the catalog.
 * @returns `{ packages, complete }`; incomplete only when the mirror is absent.
 */
async function listPackages(config, onWarning) {
  const declared = await packagesFromMarketplace(config, onWarning);
  if (declared !== undefined) return { packages: declared, complete: true };
  return packagesFromPluginsDir(config);
}

async function packagesFromMarketplace(config, onWarning) {
  for (const relativePath of MARKETPLACE_MANIFESTS) {
    let text;
    try {
      text = await readFile(join(config.mirrorPath, relativePath), 'utf8');
    } catch (error) {
      if (isAbsent(error)) continue;
      throw error;
    }

    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      onWarning(`${relativePath} is not valid JSON; reading plugins/ instead`);
      return undefined;
    }
    if (!Array.isArray(manifest?.plugins)) {
      onWarning(`${relativePath} has no plugins array; reading plugins/ instead`);
      return undefined;
    }

    const packages = [];
    for (const entry of manifest.plugins) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
      const source = typeof entry?.source === 'string' ? entry.source : entry?.source?.path;
      const path = typeof source === 'string' ? source.trim() : '';
      if (name === '' || path === '') {
        onWarning(`${relativePath} has a package entry without a name and source path`);
        continue;
      }
      const dir = resolve(config.mirrorPath, path);
      if (!isInside(config.mirrorPath, dir)) {
        onWarning(`${relativePath}: package "${name}" points outside the mirror; ignored`);
        continue;
      }
      packages.push({ name, dir });
    }

    return packages.sort((left, right) => left.name.localeCompare(right.name)).filter((item) => isSelected(config, item.name));
  }

  return undefined;
}

async function packagesFromPluginsDir(config) {
  const pluginsDir = join(config.mirrorPath, 'plugins');
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return { packages: [], complete: false };
    throw error;
  }

  const packages = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, dir: join(pluginsDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .filter((item) => isSelected(config, item.name));

  return { packages, complete: true };
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

/**
 * Read-only snapshot for `/marketplace`: each package's name, version and skill
 * count, plus whether the mirror could be read at all.
 * @param config - a normalized configuration.
 * @param onWarning - sink for unreadable manifests or directories.
 * @returns `{ packages, complete }`.
 */
export async function describeMarketplace(config, onWarning = () => {}) {
  const { packages, complete } = await listPackages(config, onWarning);
  const rows = [];
  for (const item of packages) {
    const manifest = await readPluginManifest(item.dir);
    rows.push({
      name: item.name,
      version: typeof manifest?.version === 'string' ? manifest.version : undefined,
      skills: await countSkills(join(item.dir, 'skills')),
    });
  }
  return { packages: rows, complete };
}

async function countSkills(skillsDir) {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).length;
  } catch (error) {
    if (isAbsent(error)) return 0;
    throw error;
  }
}

function isSelected(config, plugin) {
  if (config.plugins.include.length > 0 && !config.plugins.include.includes(plugin)) return false;
  return !config.plugins.exclude.includes(plugin);
}

function resolveSkillName(config, item, duplicates) {
  if (config.namespace === 'none') return item.name;
  if (config.namespace === 'collision' && (duplicates.get(item.name) ?? 0) === 1) return item.name;
  return `${slug(item.plugin)}-${item.name}`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readPluginManifest(pluginDir) {
  try {
    const parsed = JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Skill document parsing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse one `SKILL.md` and resolve DSH's invocation policy from its frontmatter.
 * @param text - the raw file contents.
 * @returns a discriminated result; `reason` explains a skipped file.
 */
export function parseSkillDocument(text) {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter === undefined) return { ok: false, reason: 'missing YAML frontmatter' };

  const data = frontmatter.data;
  const name = stringField(data, 'name');
  const description = stringField(data, 'description');
  if (name === undefined) return { ok: false, reason: 'frontmatter requires a name' };
  if (description === undefined) return { ok: false, reason: 'frontmatter requires a description' };
  if (!SKILL_NAME.test(name)) return { ok: false, reason: `invalid skill name "${name}"` };

  let disableModelInvocation;
  let userInvocable;
  try {
    disableModelInvocation = readToggle(data['disable-model-invocation'], 'disable-model-invocation');
    userInvocable = readToggle(data['user-invocable'], 'user-invocable');
  } catch (error) {
    return { ok: false, reason: message(error) };
  }

  const whenToUse = stringField(data, 'whenToUse');
  const unsupported = HOST_SPECIFIC_FIELDS.filter((field) => Object.hasOwn(data, field));
  return {
    ok: true,
    skill: {
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation: {
        modelInvocable: disableModelInvocation !== true,
        userInvocable: userInvocable !== false,
      },
      unsupported,
      body: frontmatter.body,
    },
  };
}

/**
 * Split a Markdown file into its YAML frontmatter map and body.
 * @param text - the raw file contents.
 * @returns the parsed map and body, or `undefined` when the file has no frontmatter.
 */
export function parseFrontmatter(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return undefined;

  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '---' || line === '...') {
      close = index;
      break;
    }
  }
  if (close === -1) return undefined;

  return {
    data: parseYamlSubset(lines.slice(1, close)),
    body: lines.slice(close + 1).join('\n').trim(),
  };
}

/**
 * A deliberately small YAML subset: top-level `key: value` scalars plus `|`/`>`
 * block scalars. Nested maps are ignored — DSH only reads scalar frontmatter.
 */
function parseYamlSubset(lines) {
  const data = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;

    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;

    const key = match[1];
    const rest = match[2];
    const block = /^([|>])([+-]?)\s*$/.exec(rest);
    if (block === null) {
      data[key] = parseScalar(rest);
      continue;
    }

    const collected = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const next = lines[cursor];
      if (next.trim() === '') {
        collected.push('');
        continue;
      }
      if (!/^\s/.test(next)) break;
      collected.push(next.startsWith('  ') ? next.slice(2) : next.trimStart());
    }
    index = cursor - 1;

    let value = collected.join(block[1] === '|' ? '\n' : ' ');
    if (block[2] !== '-') value = value.replace(/\n+$/, '');
    data[key] = value;
  }
  return data;
}

function parseScalar(text) {
  const value = text.trim();
  if (value === '') return '';
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(value)) return Number(value);
  return value;
}

function unescapeDoubleQuoted(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character;
      continue;
    }
    index += 1;
    const next = value[index];
    if (next === undefined) break;
    if (next === 'n') output += '\n';
    else if (next === 't') output += '\t';
    else if (next === 'r') output += '\r';
    else output += next;
  }
  return output;
}

function readToggle(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  throw new Error(`${key} must be a boolean`);
}

function stringField(data, key) {
  const value = data[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isAbsent(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function isAbsentExecutable(error) {
  return error?.code === 'ENOENT' || error?.code === 'EACCES';
}

async function pathExists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function message(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '[unrenderable error]';
  }
}

/** Exported for tests only; not part of the plugin's runtime contract. */
export const __internals = Object.freeze({ parseYamlSubset, readToggle, slug, pathExists });
