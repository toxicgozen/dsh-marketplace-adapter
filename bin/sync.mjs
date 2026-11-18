#!/usr/bin/env node
import { collectSkillCandidates, normalizeConfig } from '../index.js';
import { ArchiveCache } from '../archive.js';

const flags = {};
const argv = process.argv.slice(2);
const allowed = new Set(['url', 'repository', 'ref', 'cachePath', 'mirrorPath', 'tokenEnv', 'namespace', 'providerName', 'descriptionPrefix', 'fetchTimeoutMs']);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('Usage: node bin/sync.mjs --url owner/repo [--ref branch] [--tokenEnv NAME] [--cachePath directory]\nAliases: --repository for --url; --mirrorPath retains the legacy read-only root.\nOther flags: --namespace --providerName --descriptionPrefix true|false --fetchTimeoutMs number\n');
} else {
  try {
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index].slice(2);
      const value = argv[index + 1];
      if (!argv[index].startsWith('--') || !allowed.has(key) || value === undefined || value.startsWith('--')) throw new Error('expected a supported --key value pair; run --help');
      if (key === 'descriptionPrefix') {
        if (!['true', 'false'].includes(value)) throw new Error('--descriptionPrefix requires true or false');
        flags[key] = value === 'true';
      } else flags[key] = key === 'fetchTimeoutMs' ? Number(value) : value;
    }
    const config = normalizeConfig(flags);
    const snapshot = await new ArchiveCache(config).sync();
    const { candidates } = await collectSkillCandidates({ ...config, mirrorPath: snapshot.root });
    process.stdout.write([
      `snapshot ${snapshot.root}`,
      `digest   ${snapshot.revision}`,
      `source   ${snapshot.sourceKey}`,
      `skills   ${candidates.length}`,
      `visible  ${candidates.filter((candidate) => candidate.invocation.modelInvocable).length}`,
      '',
    ].join('\n'));
  } catch (error) {
    process.stderr.write(`marketplace: ${error.message}\n`);
    process.exitCode = 1;
  }
}
