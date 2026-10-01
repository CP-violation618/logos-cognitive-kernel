/**
 * Verify the YAML validator catches the defect that actually cost a CI failure.
 *
 * A test that has never been seen to fail is a test you do not know works. This
 * runs the validator against the ORIGINAL broken line — the one GitHub rejected
 * with nothing more informative than "workflow file issue" — and asserts it is
 * caught, then against the fix and asserts it is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { yamlProblems } from '../test/yaml-problems.ts';

const root = join(import.meta.dirname, '..');

test('validator: catches the unquoted colon that broke CI', () => {
  const broken = [
    'jobs:',
    '  zero-dependencies:',
    '    steps:',
    '      - name: Assert no import resolves outside node: and ./',
    '        shell: bash',
  ].join('\n');

  const problems = yamlProblems(broken);
  assert.ok(
    problems.length >= 1,
    'the validator failed to catch the exact defect that cost a CI run',
  );
  assert.match(problems[0] as string, /nested mapping/);
});

test('validator: accepts the fix', () => {
  const fixed = [
    'jobs:',
    '  zero-dependencies:',
    '    steps:',
    "      - name: 'Assert no import resolves outside node: and ./'",
    '        shell: bash',
  ].join('\n');

  assert.deepEqual(yamlProblems(fixed), []);
});

test('validator: catches tab indentation', () => {
  const tabbed = ['jobs:', '\tbuild:', '    runs-on: ubuntu-latest'].join('\n');
  const problems = yamlProblems(tabbed);
  assert.ok(problems.some((p) => /tab/.test(p)), `expected a tab complaint, got: ${problems.join('; ')}`);
});

test('validator: says nothing about colons that are not followed by a space', () => {
  // URLs, timestamps and `key:value` all contain colons and are all fine.
  const fine = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    env:',
    '      URL: https://example.com:8443/path',
    '      TIME: 12:30:45',
    "      EXPR: ${{ github.ref }}",
  ].join('\n');

  assert.deepEqual(yamlProblems(fine), []);
});

test('validator: ignores the body of a block scalar', () => {
  // Block scalars are text. A shell script inside one routinely contains ": ",
  // and reporting it would make the validator useless on any real workflow.
  const withScript = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: run something',
    '        run: |',
    '          echo "note: this colon is inside a script"',
    '          grep -n "a: b" file.txt',
    '      - name: after the script',
    "        run: echo 'done'",
  ].join('\n');

  assert.deepEqual(yamlProblems(withScript), []);
});

test('validator: ignores quoted values containing colons', () => {
  const quoted = [
    'jobs:',
    '  build:',
    '    steps:',
    "      - name: 'step: with a colon'",
    '        run: "echo a: b"',
  ].join('\n');

  assert.deepEqual(yamlProblems(quoted), []);
});

test('validator: the real workflow passes', () => {
  const workflows = join(root, '.github', 'workflows');
  for (const name of ['ci.yml']) {
    const text = readFileSync(join(workflows, name), 'utf8');
    assert.deepEqual(yamlProblems(text), [], `${name} would be rejected by GitHub`);
  }
});
