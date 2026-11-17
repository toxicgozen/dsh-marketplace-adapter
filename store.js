import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

const FIELDS = ['name', 'url', 'repository', 'ref', 'tokenEnv', 'cachePath', 'mirrorPath', 'namespace', 'rank', 'providerName', 'plugins', 'descriptionPrefix', 'respectDisableModelInvocation', 'syncOnApply', 'syncIntervalMinutes', 'fetchTimeoutMs'];

function parse(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('marketplace store is not valid JSON; refusing to overwrite it'); }
  if (value?.version !== 1 || !Array.isArray(value.marketplaces) || (value.removed !== undefined && !Array.isArray(value.removed))) throw new Error('marketplace store has an invalid v1 structure');
  if (value.marketplaces.some((item) => item === null || typeof item !== 'object' || Array.isArray(item)) || (value.removed ?? []).some((name) => typeof name !== 'string')) throw new Error('marketplace store contains invalid entries');
  return { marketplaces: value.marketplaces, removed: value.removed ?? [] };
}

export function readMarketplaceStoreSync(path) {
  try { return parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { marketplaces: [], removed: [] }; throw error; }
}

export async function readMarketplaceStore(path) {
  try { return parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { marketplaces: [], removed: [] }; throw error; }
}

export async function updateMarketplaceStore(path, mutate) {
  await mkdir(dirname(path), { recursive: true });
  let compromised;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
    onCompromised(error) { compromised = error; },
  });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readMarketplaceStore(path);
    const result = await mutate(current);
    if (compromised) throw compromised;
    if (result.changed !== false) {
      const marketplaces = current.marketplaces.map((entry) => Object.fromEntries(FIELDS.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]])));
      await writeFile(temp, `${JSON.stringify({ version: 1, marketplaces, removed: current.removed }, null, 2)}\n`, { flag: 'wx' });
      if (compromised) throw compromised;
      await rename(temp, path);
    }
    return result;
  } finally {
    try { await rm(temp, { force: true }); } finally { await release(); }
  }
}
