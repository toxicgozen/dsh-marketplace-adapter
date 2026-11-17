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
 * @module @local/dsh-skill-plugins
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);

/** The public skill-name grammar enforced by `@deepseek-ai/dsh-skill`. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_PROVIDER = 'toxicgozen';
const DEFAULT_REPOSITORY = 'https://github.com/toxicgozen/skills.git';
const DEFAULT_REF = 'main';
const DEFAULT_RANK = 300;
const DEFAULT_TOKEN_COMMAND = Object.freeze(['gh', 'auth', 'token']);
const NAMESPACES = Object.freeze(['none', 'collision', 'plugin']);
const SSL_BACKENDS = Object.freeze(['auto', 'openssl', 'schannel']);
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
  const normalized = normalizeConfig(config);
  let provider;

  ctx.skills.registerProvider((control) => {
    provider = new SkillPluginsProvider(ctx, normalized, control);
    return provider;
  });

  provider.start();
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
    throw new TypeError('skill-plugins: config must be an object');
  }

  const repository = optionalString(raw.repository) ?? DEFAULT_REPOSITORY;
  const ref = optionalString(raw.ref) ?? DEFAULT_REF;
  const mirrorPath = resolve(optionalString(raw.mirrorPath) ?? defaultMirrorPath(repository));

  const namespace = optionalString(raw.namespace) ?? 'plugin';
  if (!NAMESPACES.includes(namespace)) {
    throw new Error(`skill-plugins: namespace must be one of ${NAMESPACES.join(', ')} (got "${namespace}")`);
  }

  const sslBackend = optionalString(raw.sslBackend) ?? 'auto';
  if (!SSL_BACKENDS.includes(sslBackend)) {
    throw new Error(`skill-plugins: sslBackend must be one of ${SSL_BACKENDS.join(', ')} (got "${sslBackend}")`);
  }

  const providerName = optionalString(raw.providerName) ?? DEFAULT_PROVIDER;
  if (providerName === 'runtime') {
    throw new Error('skill-plugins: providerName "runtime" is reserved by the skill registry');
  }

  return {
    repository,
    ref,
    mirrorPath,
    namespace,
    providerName,
    sslBackend,
    plugins: normalizePlugins(raw.plugins),
    descriptionPrefix: optionalBoolean(raw.descriptionPrefix, false),
    respectDisableModelInvocation: optionalBoolean(raw.respectDisableModelInvocation, true),
    syncOnApply: optionalBoolean(raw.syncOnApply, true),
    syncIntervalMinutes: optionalNumber(raw.syncIntervalMinutes, 60, 0),
    gitPath: optionalString(raw.gitPath) ?? 'git',
    tokenCommand: normalizeTokenCommand(raw.tokenCommand),
    cloneTimeoutMs: optionalNumber(raw.cloneTimeoutMs, 300000, 1000),
    fetchTimeoutMs: optionalNumber(raw.fetchTimeoutMs, 180000, 1000),
    tokenTimeoutMs: optionalNumber(raw.tokenTimeoutMs, 20000, 1000),
    rank: optionalNumber(raw.rank, DEFAULT_RANK, 0),
  };
}

function normalizePlugins(value) {
  if (value === undefined || value === null) return { include: [], exclude: [] };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('skill-plugins: plugins must be an object with optional include/exclude arrays');
  }
  return {
    include: stringArray(value.include, 'plugins.include'),
    exclude: stringArray(value.exclude, 'plugins.exclude'),
  };
}

function stringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`skill-plugins: ${field} must be an array of non-empty strings`);
  }
  return [...value];
}

function normalizeTokenCommand(value) {
  if (value === undefined) return DEFAULT_TOKEN_COMMAND;
  if (value === null || value === 'none') return null;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part.length > 0)) {
    return [...value];
  }
  throw new Error('skill-plugins: tokenCommand must be a non-empty string array, or "none"');
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optionalBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`skill-plugins: expected a boolean, got ${typeof value}`);
  return value;
}

function optionalNumber(value, fallback, minimum) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`skill-plugins: expected a number >= ${minimum}, got ${String(value)}`);
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
export class GitMirror {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger ?? console;
    this.tokenResolved = false;
    this.token = undefined;
  }

  /**
   * Align the working copy with `origin/<ref>`.
   * @returns the short revision now checked out.
   */
  async sync() {
    const config = this.config;
    await mkdir(dirname(config.mirrorPath), { recursive: true });

    if (await pathExists(join(config.mirrorPath, '.git'))) {
      await this.git(['-C', config.mirrorPath, 'fetch', '--depth', '1', 'origin', config.ref], config.fetchTimeoutMs);
      await this.git(['-C', config.mirrorPath, 'reset', '--hard', 'FETCH_HEAD'], config.fetchTimeoutMs);
    } else {
      if (await pathExists(config.mirrorPath)) {
        const existing = await readdir(config.mirrorPath);
        if (existing.length > 0) {
          throw new Error(`mirror path is not a Git checkout: ${config.mirrorPath}`);
        }
      }
      await this.git(
        ['clone', '--depth', '1', '--branch', config.ref, config.repository, config.mirrorPath],
        config.cloneTimeoutMs,
      );
    }

    const head = await this.git(['-C', config.mirrorPath, 'rev-parse', '--short', 'HEAD'], 15000);
    return head.stdout.trim();
  }

  async git(args, timeoutMs) {
    try {
      return await this.execGit(args, timeoutMs, false);
    } catch (error) {
      const text = message(error);
      const tlsFailure = /schannel|SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle/i.test(text);
      if (this.config.sslBackend === 'auto' && tlsFailure) {
        this.logger.info('skill-plugins: retrying Git with http.sslBackend=openssl');
        return this.execGit(args, timeoutMs, true);
      }
      throw error;
    }
  }

  async execGit(args, timeoutMs, forceOpenSsl) {
    const env = await this.gitEnvironment(forceOpenSsl);
    try {
      return await execFileAsync(this.config.gitPath, args, {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      });
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
      throw new Error(stderr === '' ? message(error) : stderr);
    }
  }

  async gitEnvironment(forceOpenSsl) {
    const config = this.config;
    const pairs = [
      ['core.autocrlf', 'false'],
      ['core.eol', 'lf'],
      ['core.longpaths', 'true'],
    ];
    const backend = forceOpenSsl ? 'openssl' : config.sslBackend === 'auto' ? undefined : config.sslBackend;
    if (backend !== undefined) pairs.push(['http.sslBackend', backend]);

    const token = await this.resolveToken();
    if (token !== undefined) {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      pairs.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
    }

    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key];
    }
    pairs.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    env.GIT_CONFIG_COUNT = String(pairs.length);
    return env;
  }

  /**
   * Resolve a GitHub token without ever putting it on a command line: an
   * environment variable first, then the configured token command.
   * @returns the token, or `undefined` to attempt an unauthenticated fetch.
   */
  async resolveToken() {
    if (this.tokenResolved) return this.token;
    this.tokenResolved = true;

    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      const value = process.env[key];
      if (typeof value === 'string' && value.trim() !== '') {
        this.token = value.trim();
        return this.token;
      }
    }

    const command = this.config.tokenCommand;
    if (command === null) return undefined;
    try {
      const result = await execFileAsync(command[0], command.slice(1), {
        timeout: this.config.tokenTimeoutMs,
        windowsHide: true,
        encoding: 'utf8',
      });
      const value = result.stdout.trim();
      if (value !== '') this.token = value;
    } catch (error) {
      if (isAbsentExecutable(error)) return undefined;
      this.logger.warn(`skill-plugins: token command failed: ${message(error)}`);
    }
    return this.token;
  }
}

/**
 * One-shot mirror synchronization, shared by the provider and the `bin/` CLI.
 * @param config - a normalized configuration.
 * @param logger - sink for retry and token diagnostics.
 * @returns the short revision checked out.
 */
export async function syncMirror(config, logger = console) {
  return new GitMirror(config, logger).sync();
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

class SkillPluginsProvider {
  constructor(ctx, config, control) {
    this.ctx = ctx;
    this.config = config;
    this.control = control;
    this.name = config.providerName;
    this.disposed = false;
    this.syncing = undefined;
    this.lastSyncAt = 0;
    this.mirror = new GitMirror(config, ctx.logger);
    this.warned = new Set();
    control.signal.addEventListener('abort', () => {
      this.disposed = true;
    }, { once: true });
  }

  /** Kick off the first synchronization without blocking plugin activation. */
  start() {
    if (this.config.syncOnApply) this.runSync();
  }

  /**
   * `ctx.skills` provider discovery.
   * @param options - lookup options; only `signal` is used.
   * @returns candidate summaries, or an incomplete observation before the mirror exists.
   */
  async list(options = {}) {
    this.maybeSync();
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
    const parsed = parseSkillDocument(text);
    if (!parsed.ok) return undefined;
    return { ...candidate, content: parsed.skill.body };
  }

  warn(text) {
    const key = String(text);
    if (this.warned.has(key)) return;
    if (this.warned.size > 200) this.warned.clear();
    this.warned.add(key);
    this.ctx.logger.warn(`skill-plugins: ${key}`);
  }

  maybeSync() {
    const config = this.config;
    if (!config.syncOnApply) return;
    if (!(config.syncIntervalMinutes > 0)) return;
    if (this.syncing !== undefined) return;
    if (this.lastSyncAt === 0) return;
    if (Date.now() - this.lastSyncAt < config.syncIntervalMinutes * 60000) return;
    this.runSync();
  }

  runSync() {
    if (this.syncing !== undefined) return this.syncing;
    this.syncing = this.sync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  async sync() {
    const config = this.config;
    try {
      const revision = await this.mirror.sync();
      this.lastSyncAt = Date.now();
      this.control.invalidate();
      this.ctx.logger.info(`skill-plugins: ${config.repository}@${config.ref} at ${revision}`);
    } catch (error) {
      this.lastSyncAt = Date.now();
      this.ctx.logger.warn(`skill-plugins: sync failed: ${message(error)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Scan a mirror's `plugins/<plugin>/skills/<skill>/SKILL.md` entries.
 * @param config - a normalized configuration.
 * @param hooks - optional provider label, abort signal and warning sink.
 * @returns `{ candidates, complete }`; incomplete until the mirror first exists.
 */
export async function collectSkillCandidates(config, hooks = {}) {
  const provider = hooks.provider ?? config.providerName;
  const signal = hooks.signal;
  const onWarning = hooks.onWarning ?? (() => {});

  const pluginsDir = join(config.mirrorPath, 'plugins');
  let pluginEntries;
  try {
    pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return { candidates: [], complete: false };
    throw error;
  }

  const plugins = pluginEntries
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => isSelected(config, name));

  const collected = [];
  for (const plugin of plugins) {
    signal?.throwIfAborted?.();
    const pluginDir = join(pluginsDir, plugin);
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
  return { candidates, complete: true };
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
