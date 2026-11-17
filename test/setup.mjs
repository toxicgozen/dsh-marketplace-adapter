import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const original = process.env.DSH_HOME;
const home = mkdtempSync(join(tmpdir(), 'marketplace-home-'));
process.env.DSH_HOME = home;
after(async () => {
  if (original === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = original;
  await rm(home, { recursive: true, force: true });
});
