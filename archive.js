import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';

const MANIFESTS = ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const MAX_DOWNLOAD = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export function sourceIdentity(value, ref = 'HEAD') {
  const shorthand = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
  const url = new URL(shorthand ? `https://github.com/${value}` : value);
  if (url.username || url.password || url.hash) throw new Error('source URL must not contain credentials or a fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('source URL must use HTTPS (HTTP is allowed only on loopback for tests)');
  }
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|signature|credential|api[-_]?key/i.test(key)) throw new Error('source URL must not contain secrets; use tokenEnv');
  }
  let downloadUrl = url.href;
  if (url.hostname === 'github.com') {
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?$/.exec(url.pathname.replace(/\.git\/?$/, ''));
    if (!match || url.search) throw new Error('GitHub source must be an HTTPS repository URL or owner/repo');
    url.pathname = `/${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    downloadUrl = `https://api.github.com/repos${url.pathname}/tarball${ref === 'HEAD' ? '' : `/${encodeURIComponent(ref)}`}`;
  } else if (!/\.(tar\.gz|tgz)$/i.test(url.pathname)) {
    throw new Error('non-GitHub sources require a direct HTTPS tar.gz archive URL');
  }
  const canonicalUrl = url.href;
  return { url: canonicalUrl, downloadUrl, sourceKey: createHash('sha256').update(JSON.stringify([canonicalUrl, ref])).digest('hex') };
}

export class ArchiveCache {
  constructor(source, options = {}) {
    this.source = source;
    this.identity = sourceIdentity(source.url ?? source.repository, source.ref);
    this.directory = join(source.cachePath, this.identity.sourceKey);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.resolveToken = options.resolveToken ?? (async (name) => process.env[name]);
    this.timeoutMs = source.fetchTimeoutMs ?? 180000;
  }

  currentSync() {
    try {
      const saved = JSON.parse(readFileSync(join(this.directory, 'current.json'), 'utf8'));
      if (saved.sourceKey !== this.identity.sourceKey || !/^sha256:[a-f0-9]{64}$/.test(saved.revision)) throw new Error('invalid cached snapshot identity');
      if (typeof saved.subdir !== 'string' || saved.subdir.includes('/') || saved.subdir.includes('\\') || saved.subdir === '..') throw new Error('invalid cached snapshot root');
      const root = join(this.directory, saved.revision.slice(7), saved.subdir);
      if (!statSync(root).isDirectory()) throw new Error('cached snapshot root is missing');
      return { sourceKey: saved.sourceKey, revision: saved.revision, root };
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async current() { return this.currentSync(); }

  async sync() {
    await mkdir(this.directory, { recursive: true });
    const staging = await mkdtemp(join(this.directory, '.staging-'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let token;
    try {
      if (this.source.tokenEnv) {
        try { token = await this.resolveToken(this.source.tokenEnv); }
        catch { throw new Error(`credential ${this.source.tokenEnv} could not be resolved`); }
        if (!token) throw new Error(`credential ${this.source.tokenEnv} is not configured`);
      }
      const bytes = await this.download(token, controller.signal);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const archive = join(staging, 'archive.tar');
      let expanded = 0;
      await pipeline(
        [bytes], createGunzip(),
        new Transform({ transform(chunk, _encoding, done) {
          expanded += chunk.length;
          done(expanded > MAX_EXPANDED ? new Error('archive exceeds expanded size limit') : null, chunk);
        } }), createWriteStream(archive),
      );
      let count = 0;
      let invalid;
      await tar.t({ file: archive, strict: true, preservePaths: true, onReadEntry(entry) {
        count += 1;
        if (count > MAX_ENTRIES) invalid = 'archive exceeds entry limit';
        const path = entry.path;
        if (!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || path.split('/').includes('..')) invalid = 'archive contains an unsafe path';
        if (!['File', 'Directory'].includes(entry.type)) invalid = 'archive contains a link or special file';
      } });
      if (invalid) throw new Error(invalid);
      const tree = join(staging, 'tree');
      await mkdir(tree);
      await tar.x({ file: archive, cwd: tree, strict: true, preservePaths: false, noChmod: true });
      const subdir = await validatedRoot(tree);
      const destination = join(this.directory, digest);
      try { await rename(tree, destination); } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !(await stat(destination)).isDirectory()) throw error;
      }
      const saved = { sourceKey: this.identity.sourceKey, revision: `sha256:${digest}`, subdir };
      const temp = join(this.directory, `.current-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, `${JSON.stringify(saved)}\n`, { flag: 'wx' });
        const currentPath = join(this.directory, 'current.json');
        try {
          await rename(temp, currentPath);
        } catch (error) {
          if (!['EPERM', 'EEXIST', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
          let current;
          try { current = JSON.parse(await readFile(currentPath, 'utf8')); } catch { throw error; }
          if (current?.sourceKey !== saved.sourceKey || current.revision !== saved.revision || current.subdir !== saved.subdir) throw error;
        }
      } finally { await rm(temp, { force: true }); }
      return { sourceKey: saved.sourceKey, revision: saved.revision, root: join(destination, subdir) };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new Error(token ? text.replaceAll(token, '[redacted]') : text);
    } finally {
      clearTimeout(timeout);
      await rm(staging, { recursive: true, force: true });
    }
  }

  async download(token, signal) {
    let url = new URL(this.identity.downloadUrl);
    let authorized = true;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = { accept: 'application/vnd.github+json' };
      if (token && authorized) headers.authorization = `Bearer ${token}`;
      let response;
      try { response = await this.fetch(url.href, { headers, signal, redirect: 'manual' }); }
      catch { throw new Error(signal.aborted ? 'archive download timed out' : 'archive download failed'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('archive redirect has no location');
        let next;
        try { next = new URL(location, url); } catch { throw new Error('invalid archive redirect'); }
        if (next.username || next.password || !['https:', 'http:'].includes(next.protocol)) throw new Error('unsafe archive redirect');
        if (next.protocol === 'http:' && (url.protocol === 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(next.hostname))) throw new Error('archive redirect requires HTTPS');
        authorized = authorized && next.origin === url.origin;
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`archive HTTP ${response.status}`); }
      if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) { await response.body?.cancel(); throw new Error('archive exceeds download size limit'); }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > MAX_DOWNLOAD) throw new Error('archive exceeds download size limit');
          chunks.push(chunk);
        }
      } catch {
        throw new Error(size > MAX_DOWNLOAD ? 'archive exceeds download size limit' : signal.aborted ? 'archive download timed out' : 'archive download failed');
      }
      return Buffer.concat(chunks);
    }
    throw new Error('too many archive redirects');
  }
}

async function validatedRoot(tree) {
  if (await validTree(tree)) return '';
  const entries = await readdir(tree, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory() && await validTree(join(tree, entries[0].name))) return entries[0].name;
  throw new Error('archive has no plugins directory or valid marketplace manifest');
}

async function validateDirectory(root, directory) {
  const path = relative(root, directory);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('archive package points outside its root');
  try { if ((await stat(directory)).isDirectory()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  throw new Error('archive package directory is missing');
}

async function validTree(root) {
  for (const file of MANIFESTS) {
    let text;
    try { text = await readFile(join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const plugins = JSON.parse(text)?.plugins;
    if (!Array.isArray(plugins)) throw new Error('archive marketplace manifest requires a plugins array');
    for (const plugin of plugins) {
      if (plugin?.source && typeof plugin.source === 'object' && plugin.source.source !== undefined && plugin.source.source !== 'local') continue;
      const path = typeof plugin?.source === 'string' ? plugin.source : plugin?.source?.path;
      if (typeof plugin?.name !== 'string' || !plugin.name.trim() || typeof path !== 'string' || !path.trim()) throw new Error('archive package requires a name and local source path');
      const directory = resolve(root, path);
      await validateDirectory(root, directory);
      if (plugin.skills !== undefined) {
        if (!Array.isArray(plugin.skills) || plugin.skills.some((skill) => typeof skill !== 'string' || !skill.trim())) throw new Error('archive package has invalid skills directories');
        for (const skill of plugin.skills) await validateDirectory(directory, resolve(directory, skill));
      }
    }
    return true;
  }
  try { return (await stat(join(root, 'plugins'))).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
