import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter, parseSkillDocument, normalizeConfig, defaultMirrorPath } from '../index.js';

test('indented YAML separators remain in the description and preserve following invocation fields', () => {
  for (const separator of ['---', '...']) {
    const parsed = parseSkillDocument(`---\nname: alpha\ndescription: |\n  First line.\n  ${separator}\n  Last line.\nuser-invocable: false\n---  \nBody.`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skill.invocation.userInvocable, false);
    assert.equal(parsed.skill.description, `First line.\n${separator}\nLast line.`);
    assert.equal(parsed.skill.body, 'Body.');
  }
});

test('uses complete YAML semantics and reports malformed documents', () => {
  const parsed = parseSkillDocument('---\nname: alpha # comment\ndescription: >-\n  first line\n  second line\nwhenToUse: "\\u4e2d\\u6587"\npaths:\n  - "**/*.ts"\n---\nBody.');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.name, 'alpha');
  assert.equal(parsed.skill.description, 'first line second line');
  assert.equal(parsed.skill.whenToUse, '中文');
  for (const yaml of ['name: alpha\nname: beta\ndescription: A.', 'name: alpha\ndescription: [broken', '[one, two]']) {
    const invalid = parseSkillDocument(`---\n${yaml}\n---\n`);
    assert.equal(invalid.ok, false);
    assert.match(invalid.reason, /YAML|mapping/);
  }
});

test('parses a plain frontmatter block and trims the body', () => {
  const parsed = parseFrontmatter('---\nname: ticktick-organize-tasks\ndescription: Organize tasks.\n---\n\n# Heading\n\nBody text.\n');
  assert.equal(parsed.data.name, 'ticktick-organize-tasks');
  assert.equal(parsed.data.description, 'Organize tasks.');
  assert.equal(parsed.body, '# Heading\n\nBody text.');
});

test('handles CRLF line endings', () => {
  const parsed = parseFrontmatter('---\r\nname: alpha\r\ndescription: Beta.\r\n---\r\nBody.\r\n');
  assert.equal(parsed.data.name, 'alpha');
  assert.equal(parsed.body, 'Body.');
});

test('keeps colons inside a double-quoted description', () => {
  const parsed = parseFrontmatter('---\nname: alpha\ndescription: "Use for a: b, and c: d."\n---\nBody.\n');
  assert.equal(parsed.data.description, 'Use for a: b, and c: d.');
});

test('unescapes single quotes and double quotes', () => {
  assert.equal(parseFrontmatter("---\ndescription: 'it''s fine'\n---\n").data.description, "it's fine");
  assert.equal(parseFrontmatter('---\ndescription: "a \\"quoted\\" word"\n---\n').data.description, 'a "quoted" word');
});

test('supports folded block scalars', () => {
  const parsed = parseFrontmatter('---\nname: alpha\ndescription: >\n  first line\n  second line\n---\nBody.\n');
  assert.equal(parsed.data.description, 'first line second line\n');
});

test('returns undefined without frontmatter', () => {
  assert.equal(parseFrontmatter('# Just markdown\n'), undefined);
  assert.equal(parseFrontmatter('---\nname: alpha\n'), undefined);
});

test('maps disable-model-invocation to a model-only exclusion', () => {
  const result = parseSkillDocument('---\nname: alpha\ndescription: A.\ndisable-model-invocation: true\n---\nBody.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.skill.invocation, { modelInvocable: false, userInvocable: true });
});

test('maps user-invocable to a user-only exclusion', () => {
  const result = parseSkillDocument('---\nname: alpha\ndescription: A.\nuser-invocable: no\n---\nBody.');
  assert.equal(result.ok, true);
  assert.deepEqual(result.skill.invocation, { modelInvocable: true, userInvocable: false });
});

test('accepts the documented boolean spellings', () => {
  for (const spelling of ['true', 'True', 'yes', 'on', '1', 'TRUE']) {
    assert.equal(
      parseSkillDocument(`---\nname: alpha\ndescription: A.\ndisable-model-invocation: ${spelling}\n---\n`).skill.invocation.modelInvocable,
      false,
      spelling,
    );
  }
  for (const spelling of ['false', 'no', 'off', '0']) {
    assert.equal(
      parseSkillDocument(`---\nname: alpha\ndescription: A.\ndisable-model-invocation: ${spelling}\n---\n`).skill.invocation.modelInvocable,
      true,
      spelling,
    );
  }
});

test('rejects an invalid invocation value instead of permitting the surface', () => {
  const result = parseSkillDocument('---\nname: alpha\ndescription: A.\ndisable-model-invocation: maybe\n---\n');
  assert.equal(result.ok, false);
  assert.match(result.reason, /must be a boolean/);
});

test('rejects non-kebab names and missing descriptions', () => {
  assert.equal(parseSkillDocument('---\nname: Bad_Name\ndescription: A.\n---\n').ok, false);
  assert.equal(parseSkillDocument('---\nname: alpha\n---\n').ok, false);
  assert.equal(parseSkillDocument('no frontmatter').ok, false);
});

test('carries whenToUse through', () => {
  const result = parseSkillDocument('---\nname: alpha\ndescription: A.\nwhenToUse: "When writing tests."\n---\n');
  assert.equal(result.skill.whenToUse, 'When writing tests.');
});

test('defaults the mirror inside DSH_HOME', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = 'C:\\Users\\example\\.dsh';
  try {
    assert.match(defaultMirrorPath('https://github.com/toxicgozen/skills.git'), /skill-mirrors[\\/]toxicgozen-skills$/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('rejects an unknown namespace and the reserved provider name', () => {
  assert.throws(() => normalizeConfig({ namespace: 'colon' }), /namespace must be one of/);
  assert.throws(() => normalizeConfig({ providerName: 'runtime' }), /reserved/);
});
