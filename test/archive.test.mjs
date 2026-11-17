import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../index.js';

test('URL is the source identity and its default ref follows the remote default', () => {
  const config = normalizeConfig({ url: 'example/skills' });
  assert.equal(config.repository, 'https://github.com/example/skills');
  assert.equal(config.url, config.repository);
  assert.equal(config.ref, 'HEAD');
});
