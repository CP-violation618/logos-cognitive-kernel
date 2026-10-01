/**
 * LOGOS :: Meta tests
 * ---------------------------------------------------------------------------
 * Tests that check the PROJECT rather than its behaviour.
 *
 * Every claim a README makes is either checkable or it is marketing, and a
 * claim that nothing verifies is a claim that will quietly stop being true. CI
 * already enforces two of these from the outside; this file enforces the rest
 * from the inside, where the code can be inspected directly.
 *
 * The claims under test:
 *   · the version in the source matches the manifest;
 *   · the exported layer list describes layers that actually exist;
 *   · every public layer is reachable through the package's entry point;
 *   · there are no runtime dependencies, and no import that would create one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { VERSION, LAYERS } from '../src/index.ts';
import { yamlProblems } from './yaml-problems.ts';

const root = join(import.meta.dirname, '..');

const readManifest = (): { version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

/** Path relative to the repository root, always with forward slashes. */
const relative = (file: string): string =>
  file.replace(root, '').replace(/\\/g, '/').replace(/^\//, '');

/** Every .ts file under src/, relative to the repository root. */
const sourceFiles = (directory = join(root, 'src')): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
};

/**
 * Remove block and line comments.
 *
 * Crude — it will mangle a `//` inside a string literal — but this is used only
 * to decide whether a rule is violated in CODE, and a false negative on an
 * oddly-quoted string is a far better failure than a false positive on the
 * comment that explains the rule.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');


// ── Version agreement ───────────────────────────────────────────────────────

test('meta: the source version matches the manifest', () => {
  const manifest = readManifest();
  assert.equal(
    VERSION,
    manifest.version,
    `src/index.ts says ${VERSION} and package.json says ${manifest.version}. ` +
      'The duplication is deliberate so that a version check needs no filesystem access at load, ' +
      'and this test is what keeps the duplication honest.',
  );
});

test('meta: every minimum-Node claim agrees with the manifest', () => {
  // The floor was claimed as "22.6+" in the README, the Dockerfile, the CLI's
  // own help text, the issue template and four other places — and it was FALSE.
  // Type stripping landed in 22.6.0 behind `--experimental-strip-types` and
  // only became the default in 22.18.0, so every one of those claims was wrong
  // in the same direction. CI found it by testing the exact pinned floor.
  //
  // A version claim is the easiest kind of documentation to get wrong, because
  // nothing in the code depends on it — so it is now checked against the single
  // place that DOES have to be right for `npm install` to behave.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const declared = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? '')?.[1];

  assert.ok(
    declared !== undefined,
    `package.json engines.node must be an exact floor like ">=22.18.0", got "${String(manifest.engines?.node)}"`,
  );

  const [major, minor] = declared.split('.').map(Number) as [number, number];
  const claimed = `${major}.${minor}`;

  /** Files that state the floor to a human, and the pattern they state it with. */
  const claims: readonly { readonly file: string; readonly pattern: RegExp }[] = [
    { file: 'README.md', pattern: /node-%3E%3D(\d+\.\d+)/ },
    { file: 'README.md', pattern: /Node \*\*(\d+\.\d+\.\d+)\*\* or later/ },
    { file: 'CONTRIBUTING.md', pattern: /Node (\d+\.\d+)\+ strips/ },
    { file: 'Dockerfile', pattern: /# Node (\d+\.\d+)\+ is required/ },
    { file: 'src/cli.ts', pattern: /Node (\d+\.\d+)\+ strips types/ },
    { file: 'src/cli.ts', pattern: /Runs on Node (\d+\.\d+)\+ with no dependencies/ },
    { file: '.github/ISSUE_TEMPLATE/bug_report.yml', pattern: /The floor is (\d+\.\d+)/ },
  ];

  for (const { file, pattern } of claims) {
    const text = readFileSync(join(root, file), 'utf8');
    const found = pattern.exec(text)?.[1];
    assert.ok(found !== undefined, `${file} no longer states a Node floor matching ${String(pattern)} — update this list`);
    assert.ok(
      found === claimed || found === declared,
      `${file} claims Node ${found} but package.json requires >=${declared}. ` +
        'Every one of these has to agree, or the project tells different people different things.',
    );
  }
});

test('meta: the CI matrix tests the exact floor the manifest claims', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const floor = /^>=(.+)$/.exec(manifest.engines?.node ?? '')?.[1];
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  // Pinning the exact floor is the point. A range like "22.x" drifts upward as
  // releases land and would eventually stop testing the version the project
  // says it supports — which is precisely how the 22.6 claim survived as long
  // as it did.
  assert.ok(
    workflow.includes(`'${String(floor)}'`),
    `CI does not test the claimed floor (${String(floor)}). ` +
      'A minimum version that nothing runs against is a guess, not a claim.',
  );
});

// ── The layer list describes reality ────────────────────────────────────────

test('meta: every declared layer has a directory', () => {
  for (const layer of LAYERS) {
    const directory = join(root, 'src', layer.name);
    assert.doesNotThrow(
      () => statSync(directory),
      `layer "${layer.name}" is declared in LAYERS but src/${layer.name}/ does not exist`,
    );
  }
});

test('meta: every declared layer has a public surface', () => {
  for (const layer of LAYERS) {
    const index = join(root, 'src', layer.name, 'index.ts');
    assert.doesNotThrow(
      () => statSync(index),
      `layer "${layer.name}" has no src/${layer.name}/index.ts, so it cannot be exported`,
    );
  }
});

test('meta: layer names are unique and levels are contiguous from zero', () => {
  const names = LAYERS.map((l) => l.name);
  assert.equal(new Set(names).size, names.length, 'two layers share a name');

  // Contiguity matters because the levels are an ordering, and a gap in an
  // ordering is either a mistake or an ordering that is not what it claims.
  const levels = LAYERS.map((l) => l.level).sort((a, b) => a - b);
  assert.deepEqual(
    levels,
    levels.map((_, i) => i),
    `levels are not contiguous from zero: ${levels.join(', ')}`,
  );
});

test('meta: every declared layer states a purpose', () => {
  for (const layer of LAYERS) {
    assert.ok(layer.purpose.trim().length > 0, `layer "${layer.name}" has no stated purpose`);
  }
});

/**
 * Directories and files under src/ that are NOT layers, with the reason.
 *
 * Both directories here depend on layers while nothing depends on them, which
 * is the opposite of what a layer is. Recording them rather than silently
 * skipping them keeps the distinction a decision instead of an oversight — and
 * this check exists because an undeclared module is how an architecture quietly
 * stops having an architecture.
 */
const NON_LAYER_DIRECTORIES: Readonly<Record<string, string>> = Object.freeze({
  cognition: 'the composition root: it wires the layers together and is not one of them',
  scenarios: 'worked demonstrations: they exercise every layer and are not depended upon',
});

/**
 * Entry points. These are allowed to depend on anything, including the
 * composition root, because they are where an application begins or where the
 * package's public surface is assembled — not something another module builds
 * on.
 */
const ENTRY_POINTS: readonly string[] = Object.freeze([
  // The package's public surface. It re-exports every layer AND the
  // composition root, because a consumer of this package should be able to
  // reach the integrated agent from the same import as the kernel.
  'src/index.ts',
  // The command-line application.
  'src/cli.ts',
]);

test('meta: every layer directory is declared', () => {
  const declared = new Set<string>(LAYERS.map((l) => l.name));
  const present = readdirSync(join(root, 'src')).filter((entry) => statSync(join(root, 'src', entry)).isDirectory());

  for (const directory of present) {
    if (declared.has(directory)) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(NON_LAYER_DIRECTORIES, directory),
      `src/${directory}/ exists but is neither a declared layer nor a documented exception. ` +
        'Add it to LAYERS, or to NON_LAYER_DIRECTORIES with the reason it is not one.',
    );
  }
});

test('meta: the documented exceptions really are exceptions', () => {
  // Each must depend on layers, and must not be depended upon by any. If a
  // layer imported the composition root, the layering would be circular and the
  // exception would be hiding a real problem rather than recording a real one.
  for (const [directory, reason] of Object.entries(NON_LAYER_DIRECTORIES)) {
    assert.ok(reason.trim().length > 10, `"${directory}" has no real explanation`);

    // Checked across the DIRECTORY rather than file by file: a barrel
    // `index.ts` legitimately imports nothing at all, and requiring every file
    // to reach upward would be asserting a property the design does not have.
    const files = sourceFiles(join(root, 'src', directory));
    assert.ok(files.length > 0, `src/${directory}/ is empty but still declared an exception`);

    const dependsOnALayer = files.some((file) => /from '\.\.\//.test(readFileSync(file, 'utf8')));
    assert.ok(
      dependsOnALayer,
      `nothing in src/${directory}/ depends on any layer, so it is not the exception it claims to be`,
    );

    // A layer may not depend on a non-layer, or the layering would be circular.
    //
    // Non-layers MAY depend on each other: they all sit above the layers, and a
    // demonstration built on the composition root is exactly the relationship
    // that makes it a demonstration. The rule that matters is the one between
    // the layers and everything above them.
    const declaredLayers = new Set<string>(LAYERS.map((l) => l.name));
    for (const file of sourceFiles()) {
      const rel = relative(file);
      if (rel.startsWith(`src/${directory}/`)) continue;
      if (ENTRY_POINTS.includes(rel)) continue;

      // Only layer files are constrained.
      const owner = /^src\/([^/]+)\//.exec(rel)?.[1];
      if (owner === undefined || !declaredLayers.has(owner)) continue;

      const text = readFileSync(file, 'utf8');
      // Anchored to a path boundary: `cognition/` is a substring of
      // `metacognition/`, so an unanchored pattern would report every import of
      // the metacognition layer as a dependency on the composition root.
      for (const pattern of [
        new RegExp(`from '(?:\\.\\.?/)+${directory}/`),
        new RegExp(`from '\\./${directory}/`),
      ]) {
        assert.doesNotMatch(
          text,
          pattern,
          `${rel} is in the "${owner}" layer and imports src/${directory}/. ` +
            'A layer may only depend on layers below it; the composition root sits above them all.',
        );
      }
    }
  }
});

test('meta: entry points are reachable and actually enter something', () => {
  for (const entry of ENTRY_POINTS) {
    const full = join(root, entry);
    assert.doesNotThrow(() => statSync(full), `${entry} is listed as an entry point but does not exist`);
    const text = readFileSync(full, 'utf8');
    // An "entry point" that imports nothing from the project is not an entry
    // point, it is a file that happens to be here.
    assert.match(
      text,
      /from '\.\.?\//,
      `${entry} imports nothing from the project, so it cannot be an entry point`,
    );
  }
});

// ── The package entry point reaches every layer ─────────────────────────────

test('meta: the entry point re-exports every layer', () => {
  const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  for (const layer of LAYERS) {
    assert.match(
      index,
      new RegExp(`from '\\./${layer.name}/index\\.ts'`),
      `src/index.ts does not re-export the "${layer.name}" layer`,
    );
  }
});

test('meta: the manifest exports every layer as a subpath', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>;
  };
  const exports = manifest.exports ?? {};

  for (const layer of LAYERS) {
    assert.ok(
      exports[`./${layer.name}`] !== undefined,
      `package.json does not expose "./${layer.name}" as a subpath export`,
    );
    assert.match(
      exports[`./${layer.name}`] as string,
      new RegExp(`^./src/${layer.name}/index\\.ts$`),
      `the "./${layer.name}" export does not point at its index`,
    );
  }
});

// ── Zero dependencies, checked rather than asserted ─────────────────────────

test('meta: the manifest declares no runtime dependencies', () => {
  const manifest = readManifest();
  const runtime = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    runtime,
    [],
    `runtime dependencies were added: ${runtime.join(', ')}. ` +
      'This is the project\'s central claim — the whole architecture is auditable in an afternoon ' +
      'because there is nothing to audit but the source.',
  );
});

test('meta: the manifest declares at most the two checking dependencies', () => {
  const manifest = readManifest();
  const dev = Object.keys(manifest.devDependencies ?? {}).sort();
  // Both are for CHECKING rather than running, which is why they are allowed.
  assert.deepEqual(dev, ['@types/node', 'typescript']);
});

test('meta: no source file imports anything but node: builtins and relative paths', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    // Anchored to the start of a line and to a real import statement, so that
    // prose inside a doc comment — which quotes things liberally — is not
    // mistaken for code. An earlier unanchored version flagged every line of
    // commentary containing the word "from".
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) continue;
      if (specifier.startsWith('node:')) continue;
      offenders.push(`${file.replace(root, '')} imports "${specifier}"`);
    }
    for (const match of text.matchAll(/^\s*(?:const|let|await)\s[^\n]*?await\s+import\s*\(\s*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      offenders.push(`${file.replace(root, '')} dynamically imports "${specifier}"`);
    }
    for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      offenders.push(`${file.replace(root, '')} side-effect imports "${specifier}"`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `non-relative, non-builtin imports found:\n  ${offenders.join('\n  ')}`,
  );
});

test('meta: no source file uses Math.random', () => {
  // Every stochastic choice must come from the seeded generator, or a
  // reproducible trajectory stops being reproducible — which invalidates every
  // test that asserts on one.
  //
  // Comments are stripped first, because this RULE is documented in several
  // files by name and a check that flagged its own explanation would be worse
  // than useless.
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = stripComments(readFileSync(file, 'utf8'));
    if (/Math\.random\s*\(/.test(text)) offenders.push(file.replace(root, ''));
  }

  assert.deepEqual(
    offenders,
    [],
    `Math.random is used in:\n  ${offenders.join('\n  ')}. ` +
      'All randomness must flow through the injected Rng so that a run is replayable.',
  );
});

test('meta: no source file imports from test/ or examples/', () => {
  // The dependency direction is one-way. A source file reaching into the tests
  // would mean the tests are part of the runtime, and the published package
  // would break in a way nobody would see until it was installed.
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    if (/(?:from|import)\s*\(?\s*['"][^'"]*(?:\.\.\/)+test\//.test(text)) {
      offenders.push(file.replace(root, ''));
    }
    if (/(?:from|import)\s*\(?\s*['"][^'"]*(?:\.\.\/)+examples\//.test(text)) {
      offenders.push(file.replace(root, ''));
    }
  }

  assert.deepEqual(offenders, [], `source files reference tests or examples:\n  ${offenders.join('\n  ')}`);
});

// ── Erasable syntax ─────────────────────────────────────────────────────────

test('meta: no source file uses syntax that type stripping cannot handle', () => {
  // Node runs these .ts files directly by stripping types. `enum`, `namespace`
  // and parameter properties all emit runtime code, so they would fail at load
  // rather than at type-check time — which is the worst place to find out.
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const name = file.replace(root, '');
    if (/^\s*(?:export\s+)?enum\s+\w/m.test(text)) offenders.push(`${name}: enum`);
    if (/^\s*(?:export\s+)?namespace\s+\w/m.test(text)) offenders.push(`${name}: namespace`);
    if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w[^{]*\([^)]*\b(?:private|public|protected|readonly)\s+\w/m.test(text)) {
      offenders.push(`${name}: parameter property`);
    }
  }

  assert.deepEqual(offenders, [], `non-erasable syntax found:\n  ${offenders.join('\n  ')}`);
});

// ── Documentation exists ────────────────────────────────────────────────────

test('meta: every layer directory has a module with a header comment', () => {
  for (const layer of LAYERS) {
    const index = readFileSync(join(root, 'src', layer.name, 'index.ts'), 'utf8');
    assert.match(index, /^\/\*\*/, `src/${layer.name}/index.ts has no header comment`);
  }
});

test('meta: the required top-level documents exist', () => {
  for (const name of ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md', 'SECURITY.md', 'docs/ARCHITECTURE.md']) {
    assert.doesNotThrow(() => statSync(join(root, name)), `${name} is missing`);
  }
});

test('meta: workflow files are structurally valid YAML', () => {
  // This check exists because its absence cost a real failure. A step was named
  // `Assert no import resolves outside node: and ./` — unquoted, and containing
  // `: `, which YAML reads as the start of a nested mapping. The entire workflow
  // was rejected before a single job ran, and every run reported only "This run
  // likely failed because of a workflow file issue".
  //
  // The earlier version of this test matched STRINGS in the file and so passed
  // happily on a file GitHub would not accept. Matching text is not validating
  // syntax, and the difference only shows up where it is most expensive.
  const workflows = readdirSync(join(root, '.github', 'workflows')).filter((f) => f.endsWith('.yml'));

  assert.ok(workflows.length > 0, 'no workflow files found');

  for (const name of workflows) {
    const text = readFileSync(join(root, '.github', 'workflows', name), 'utf8');
    const problems = yamlProblems(text);
    assert.deepEqual(problems, [], `.github/workflows/${name} would be rejected by GitHub:\n  ${problems.join('\n  ')}`);
  }
});

test('meta: the CI workflow exists and enforces every claim the project makes', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  // The determinism claim is the one most likely to rot silently, because
  // nothing about adding a feature reminds you that replay was a promise.
  assert.match(workflow, /Different seeds must diverge/, 'CI no longer checks that different seeds diverge');
  assert.match(workflow, /zero-dependencies/, 'CI no longer checks the dependency claim');

  // The container job exists because the image was, for a while, the only
  // deliverable with no check behind it at all — and a Dockerfile nothing
  // builds is a Dockerfile that stops working the first time a path changes.
  assert.match(workflow, /docker build/, 'CI no longer builds the container image');
  assert.match(workflow, /does not run as root/, 'CI no longer checks the container user');
  assert.match(workflow, /no installed dependencies/, 'CI no longer checks that the image has no node_modules');
});

test('meta: the Dockerfile installs nothing at run time', () => {
  // The image is the clearest statement of the zero-dependency claim: what
  // ships is the runtime plus the source, and an `npm install` in it would mean
  // something was added that the project says it does not have.
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const installLines = dockerfile
    .split('\n')
    .filter((line) => /^\s*RUN\s/.test(line) && /\bnpm\s+(?:install|ci)\b/.test(line));

  assert.deepEqual(
    installLines,
    [],
    `the Dockerfile installs packages at build time:\n  ${installLines.join('\n  ')}`,
  );
});

test('meta: the Dockerfile runs as a non-root user', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^USER (?!root)\w+/m, 'the Dockerfile does not drop to a non-root user');
});

test('meta: every path the Dockerfile copies exists in the repository', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const copied: string[] = [];

  for (const line of dockerfile.split('\n')) {
    const match = /^\s*COPY\s+(?:--\S+\s+)*(.+?)\s+\S+\s*$/.exec(line);
    if (match === null) continue;
    for (const source of (match[1] as string).split(/\s+/)) {
      if (source === '--from') continue;
      copied.push(source);
    }
  }

  assert.ok(copied.length > 0, 'the Dockerfile copies nothing, so it cannot build anything');
  for (const source of copied) {
    assert.doesNotThrow(
      () => statSync(join(root, source)),
      `the Dockerfile copies "${source}", which does not exist — the image would fail to build`,
    );
  }
});

// ── The manual stays true ───────────────────────────────────────────────────

test('meta: every guide section that shows code has a test exercising it', () => {
  // A manual with untested examples is a manual that is wrong within a month.
  // The guide's examples live in `test/guide.test.ts`, and this check is what
  // keeps the two in step.
  //
  // Scanned line by line rather than with one regex across the whole file: a
  // greedy multi-line pattern attributed both of section 10's examples to that
  // one section and then reported the second as uncovered, which was a defect
  // in the CHECK rather than in the guide.
  const guide = readFileSync(join(root, 'docs', 'GUIDE.md'), 'utf8');
  const tests = readFileSync(join(root, 'test', 'guide.test.ts'), 'utf8');

  /** Guide section -> the `guide N:` test numbers that exercise its examples. */
  const COVERAGE: Readonly<Record<number, readonly number[]>> = Object.freeze({
    2: [2],   // the five-minute starter
    4: [1],   // the kernel
    5: [2],   // memory
    6: [3],   // attention
    7: [4],   // reasoning
    8: [5],   // goals and planning
    9: [6],   // metacognition
    10: [7],  // skills
    11: [8],  // the integrated agent
    12: [10], // the model adapter
    13: [11], // determinism and debugging
  });

  /**
   * Sections whose code blocks are deliberately untested.
   *
   * Both are reference material rather than narrative: the API quick reference
   * is a bare list of signatures with nothing to execute, and the extension
   * section describes how to register a subsystem using pieces of the standard
   * library, not a runnable program. They are listed here rather than silently
   * skipped so the exclusion is a decision someone made.
   */
  const REFERENCE_ONLY: readonly number[] = Object.freeze([16, 17]);

  const withCode = new Set<number>();
  let section = 0;

  for (const line of guide.split('\n')) {
    const heading = /^## (\d+)\./.exec(line);
    if (heading !== null) {
      section = Number(heading[1]);
      continue;
    }
    if (section > 0 && /^```ts\b/.test(line)) withCode.add(section);
  }

  assert.ok(withCode.size >= 8, `only ${withCode.size} guide sections contain code — the scan is probably broken`);

  const defined = new Set([...tests.matchAll(/test\('guide (\d+):/g)].map((m) => Number(m[1])));

  // Every test number the coverage map names must actually exist, or the map
  // would paper over a deleted test.
  for (const [guideSection, testNumbers] of Object.entries(COVERAGE)) {
    for (const testNumber of testNumbers) {
      assert.ok(
        defined.has(testNumber),
        `COVERAGE maps guide section ${guideSection} to guide test ${testNumber}, which does not exist`,
      );
    }
  }

  const uncovered = [...withCode]
    .filter((n) => !REFERENCE_ONLY.includes(n))
    .filter((n) => COVERAGE[n] === undefined)
    .sort((a, b) => a - b);

  assert.deepEqual(
    uncovered,
    [],
    `these GUIDE.md sections show TypeScript that nothing exercises: ${uncovered.join(', ')}. ` +
      'Add a test to test/guide.test.ts and map it in COVERAGE, or add the section to REFERENCE_ONLY.',
  );
});

test('meta: the quick-reference methods named in the guide exist in the source', () => {
  // The quick reference is the part of a manual most likely to rot, because it
  // is a bare list that nothing executes. Two entries were already wrong when
  // this check was written — `working.reset()` (the method is `clear()`) and
  // `resolveWhere` attributed to the wrong class.
  const guide = readFileSync(join(root, 'docs', 'GUIDE.md'), 'utf8');
  const quickRef = guide.slice(guide.indexOf('## 17. API 速查'));
  assert.ok(quickRef.length > 500, 'the quick reference section was not found');

  /**
   * Receiver -> the file whose source must contain the method.
   *
   * Deliberately a hand-written map: inferring the receiver-to-class binding
   * would need a type checker, and a wrong inference would produce a check that
   * passes for the wrong reason.
   */
  const receivers: Readonly<Record<string, string>> = Object.freeze({
    kernel: 'src/kernel/kernel.ts',
    'kernel.clock': 'src/kernel/clock.ts',
    'kernel.bus': 'src/kernel/bus.ts',
    'kernel.scheduler': 'src/kernel/scheduler.ts',
    'kernel.rng': 'src/kernel/rng.ts',
    working: 'src/memory/working.ts',
    episodic: 'src/memory/episodic.ts',
    semantic: 'src/memory/semantic.ts',
    rememberer: 'src/memory/remember.ts',
    gate: 'src/perception/gate.ts',
    world: 'src/reasoning/world-model.ts',
    beliefs: 'src/reasoning/beliefs.ts',
    goals: 'src/planning/goals.ts',
    planner: 'src/planning/planner.ts',
    calibrator: 'src/metacognition/calibration.ts',
    self: 'src/metacognition/self-model.ts',
    skills: 'src/skills/registry.ts',
    agent: 'src/cognition/agent.ts',
  });

  const missing: string[] = [];
  let checked = 0;

  for (const [receiver, file] of Object.entries(receivers)) {
    const source = readFileSync(join(root, file), 'utf8');

    // Find `receiver.method(` occurrences inside the quick-reference block.
    const pattern = new RegExp(`\\b${receiver.replace('.', '\\.')}\\.([a-zA-Z][\\w]*)\\s*\\(`, 'g');
    const seen = new Set<string>();

    for (const match of quickRef.matchAll(pattern)) {
      const method = match[1] as string;
      if (seen.has(method)) continue;
      seen.add(method);
      checked += 1;
      // `new X(...)` lines name a constructor, not a method on the receiver.
      if (method === 'constructor') continue;
      if (!new RegExp(`(?:^|[\\s.])${method}\\s*[(<]`, 'm').test(source)) {
        missing.push(`${receiver}.${method}() is documented but not found in ${file}`);
      }
    }
  }

  assert.ok(checked > 60, `only ${checked} methods were checked — the quick reference parsing is probably broken`);
  assert.deepEqual(missing, [], `the guide documents methods that do not exist:\n  ${missing.join('\n  ')}`);
});
