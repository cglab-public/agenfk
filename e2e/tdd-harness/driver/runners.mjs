/**
 * The test runners a sample project can use. Each writes the report a real
 * project on that runner would, so the server's parsers meet the same shapes
 * they meet in the field:
 *
 * - node:   node:test, junit-xml (node's own wrapper around every failure)
 * - vitest: vitest, vitest-json
 * - pytest: pytest's default junit family (xunit2: no `file` attribute), junit-xml
 * - dotnet: xUnit through JunitXml.TestLogger, junit-xml
 *
 * Every runner has the same sample: `add` (real) and `mul` (a stub returning
 * 0) in a source file, and a `math` test file with two green tests. A scenario
 * speaks in logical files (`math`, `extra`) and test kinds, never in paths:
 *
 *   green  passes                                  (add(2, 3) == 5)
 *   red    fails an assertion until mul is written (mul(2, 3) == 6)
 *   fails  always fails an assertion               (add(2, 3) == 6)
 *   error  throws something other than an assertion failure
 *
 * Test names are identifiers, so every runner can spell them.
 */
import { sh } from './lib.mjs';

const MATH_TESTS = [['adds', 'green'], ['addsZero', 'zero']];

const js = ({ head, eq }) => ({
  src: 'src/math.js',
  paths: { math: 'test/math.test.js', extra: 'test/extra.test.js', more: 'test/more.test.js' },
  comment: '//',
  source: ({ mul }) => `export const add = (a, b) => a + b;\nexport const mul = (a, b) => ${mul ? 'a * b' : '0'};\n`,
  otherSource: { 'src/extra.js': 'export const sub = (a, b) => a - b;\n' },
  render: tests => head + "import { add, mul } from '../src/math.js';\n\n" + tests.map(([name, kind]) =>
    `test(${JSON.stringify(name)}, () => { ${{
      green: eq('add(2, 3)', 5), zero: eq('add(0, 3)', 3), red: eq('mul(2, 3)', 6), fails: eq('add(2, 3)', 6), error: 'null.boom',
    }[kind]}; });\n`).join(''),
  // Loading it throws: the module it imports does not exist.
  broken: () => "import './does-not-exist.js';\n",
});

export const RUNNERS = {
  node: {
    ...js({ head: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n", eq: (a, b) => `assert.equal(${a}, ${b})` }),
    // No path argument: node 22 runs a `test/` argument as a FILE (one failing
    // test named "test"); with none it finds the *.test.js files itself. The
    // reporter does not create its directory, and .reports/ is gitignored.
    command: 'mkdir -p .reports && node --test --test-reporter=junit --test-reporter-destination=.reports/junit.xml',
    // node's junit report names no file (classname="test"): the project declares its test paths.
    surface: ['test'],
    report: { format: 'junit-xml', reportPath: '.reports/junit.xml' },
    base: { 'package.json': JSON.stringify({ name: 'sample', version: '1.0.0', type: 'module' }, null, 2) + '\n', '.gitignore': '.reports/\n' },
    setup: () => {},
  },
  vitest: {
    ...js({ head: "import { test, expect } from 'vitest';\n", eq: (a, b) => `expect(${a}).toBe(${b})` }),
    command: 'node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=.reports/vitest.json',
    report: { format: 'vitest-json', reportPath: '.reports/vitest.json' },
    base: { 'package.json': JSON.stringify({ name: 'sample', version: '1.0.0', type: 'module' }, null, 2) + '\n', '.gitignore': '.reports/\nnode_modules/\n' },
    // The image's own vitest, linked in: nothing is installed per project.
    setup: dir => sh('mkdir -p node_modules && ln -s /agenfk/node_modules/vitest node_modules/vitest', dir),
  },
  pytest: {
    src: 'src/mathx.py',
    paths: { math: 'tests/test_math.py', extra: 'tests/test_extra.py', more: 'tests/test_more.py' },
    comment: '#',
    source: ({ mul }) => `def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return ${mul ? 'a * b' : '0'}\n`,
    otherSource: { 'src/extra.py': 'def sub(a, b):\n    return a - b\n' },
    render: tests => 'from src.mathx import add, mul\n\n' + tests.map(([name, kind]) =>
      `\ndef test_${name}():\n    ${{
        green: 'assert add(2, 3) == 5', zero: 'assert add(0, 3) == 3', red: 'assert mul(2, 3) == 6', fails: 'assert add(2, 3) == 6', error: 'None.boom',
      }[kind]}\n`).join(''),
    broken: () => 'import does_not_exist\n',
    // `python -m` puts the project root on sys.path, so `src.mathx` imports;
    // the bare `pytest` script does not. No bytecode: Python trusts a cached
    // .pyc whose source has the same size and mtime second, and a scenario's
    // one-character edit is exactly that - the old test would run.
    command: 'PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -p no:cacheprovider --junitxml=.reports/junit.xml',
    report: { format: 'junit-xml', reportPath: '.reports/junit.xml' },
    base: { '.gitignore': '.reports/\n__pycache__/\n' },
    setup: () => {},
  },
  dotnet: {
    src: 'src/MathX.cs',
    paths: { math: 'test/MathTests.cs', extra: 'test/ExtraTests.cs', more: 'test/MoreTests.cs' },
    comment: '//',
    source: ({ mul }) => `namespace Sample;\n\npublic static class MathX\n{\n    public static int Add(int a, int b) => a + b;\n    public static int Mul(int a, int b) => ${mul ? 'a * b' : '0'};\n}\n`,
    otherSource: { 'src/Extra.cs': 'namespace Sample;\n\npublic static class Extra\n{\n    public static int Sub(int a, int b) => a - b;\n}\n' },
    render: (tests, file) => {
      const cls = { math: 'MathTests', extra: 'ExtraTests', more: 'MoreTests' }[file];
      return `using Xunit;\n\nnamespace Sample.Tests;\n\npublic class ${cls}\n{\n` + tests.map(([name, kind]) =>
        `    [Fact] public void ${name[0].toUpperCase()}${name.slice(1)}() { ${{
          green: 'Assert.Equal(5, MathX.Add(2, 3));', zero: 'Assert.Equal(3, MathX.Add(0, 3));', red: 'Assert.Equal(6, MathX.Mul(2, 3));',
          fails: 'Assert.Equal(6, MathX.Add(2, 3));', error: 'string s = null; _ = s.Length;',
        }[kind]} }\n`).join('') + '}\n';
    },
    // C# has no file that fails on its own: a test file that does not compile fails the build.
    broken: () => 'namespace Sample.Tests;\n\npublic class Broken { this does not compile }\n',
    command: 'dotnet test --logger "junit;LogFilePath=.reports/junit.xml"',
    // xUnit's junit report names a namespace and class, no file: the project declares its test paths.
    surface: ['test'],
    report: { format: 'junit-xml', reportPath: '.reports/junit.xml' },
    base: {
      '.gitignore': '.reports/\nbin/\nobj/\n',
      // Pinned, and restored into the image's package cache at build time: no scenario downloads.
      'Sample.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>disable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />
    <PackageReference Include="JunitXml.TestLogger" Version="6.1.0" />
  </ItemGroup>
</Project>
`,
    },
    setup: () => {},
  },
};

export const RUNNER_NAMES = Object.keys(RUNNERS);

/** The runner's kit, bound to its name: what scenarios call. */
export function kit(name) {
  const r = RUNNERS[name];
  if (!r) throw new Error(`unknown runner '${name}'`);
  return {
    name,
    ...r,
    /** The whole sample project. */
    sample: () => ({ ...r.base, [r.src]: r.source({ mul: false }), [r.paths.math]: r.render(MATH_TESTS, 'math') }),
    /** A test file's text, by logical file. */
    tests: (file, tests) => ({ [r.paths[file]]: r.render(tests, file) }),
    /** The `math` file as the sample has it, plus these tests. */
    mathWith: tests => ({ [r.paths.math]: r.render([...MATH_TESTS, ...tests], 'math') }),
    /** The `math` file with one of its tests gone, or renamed. */
    mathWithout: () => ({ [r.paths.math]: r.render(MATH_TESTS.slice(0, 1), 'math') }),
    /** The `math` file with its first test now failing: a test that was green goes red. */
    mathRed: () => ({ [r.paths.math]: r.render([['adds', 'fails'], MATH_TESTS[1]], 'math') }),
    mathRenamed: () => ({ [r.paths.math]: r.render([MATH_TESTS[0], ['addsNothing', 'zero']], 'math') }),
    /** A test file that cannot load. */
    brokenFile: () => ({ [r.paths.extra]: r.broken() }),
    /** `mul` written: the red tests go green. */
    implement: () => ({ [r.src]: r.source({ mul: true }) }),
    /** A change to code, not to a test. */
    codeChange: () => r.otherSource,
    /** An edit to an existing test file that changes nothing it tests. */
    touchMath: () => ({ [r.paths.math]: r.render(MATH_TESTS, 'math') + `${r.comment} edited\n` }),
  };
}
