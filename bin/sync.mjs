#!/usr/bin/env node
/**
 * Refresh (or pre-warm) the skill mirror outside the Harness.
 *
 * Useful for a first clone, for CI-style checks, or for refreshing when the
 * plugin runs with `syncOnApply: false`. Flags map straight onto the plugin's
 * `config` keys; pass string values only.
 *
 *   node bin/sync.mjs
 *   node bin/sync.mjs --mirrorPath D:\cache\skills --namespace none
 */

import { collectSkillCandidates, normalizeConfig, syncMirror } from '../index.js';

const flags = {};
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(
    [
      'Usage: node bin/sync.mjs [--key value ...]',
      '',
      'Flags: --repository --ref --mirrorPath --namespace --providerName',
      '       --sslBackend --gitPath --descriptionPrefix',
      '',
      'Defaults live in index.js normalizeConfig().',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (!argument.startsWith('--')) continue;
  const key = argument.slice(2);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    flags[key] = true;
    continue;
  }
  flags[key] = value;
  index += 1;
}

const config = normalizeConfig(flags);
const revision = await syncMirror(config);
const { candidates } = await collectSkillCandidates(config);

process.stdout.write(
  [
    `mirror   ${config.mirrorPath}`,
    `revision ${revision}`,
    `skills   ${candidates.length}`,
    `visible  ${candidates.filter((candidate) => candidate.invocation.modelInvocable).length}`,
    `sample   ${candidates.slice(0, 3).map((candidate) => candidate.name).join(', ')}`,
    '',
  ].join('\n'),
);
