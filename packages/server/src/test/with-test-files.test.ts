/**
 * @file acceaa54 — which report commands can be told to run only some files.
 * Only where the runner's file arguments are certain; anything else is null,
 * and the capture runs the whole suite.
 */
import { describe, it, expect } from 'vitest';
import { withTestFiles, quoteArg } from '../testReportHint';

const F = ['src/a.test.ts', "it's.test.ts"];
const Q = `'src/a.test.ts' 'it'\\''s.test.ts'`;

// #208: the shell that runs it is sh off Windows and cmd.exe on it; each block names its platform.
const posix = (command: string, scripts: Record<string, string>, files: readonly string[]) => withTestFiles(command, scripts, files, 'linux');

describe('withTestFiles', () => {
  it('appends the files, quoted, to a runner that takes them', () => {
    expect(posix('npx vitest run --reporter=json', {}, F)).toBe(`npx vitest run --reporter=json ${Q}`);
    expect(posix('pytest --junitxml=r.xml', {}, F)).toBe(`pytest --junitxml=r.xml ${Q}`);
    expect(posix('node --test --test-reporter=junit', {}, F)).toBe(`node --test --test-reporter=junit ${Q}`);
  });

  it('puts them after the last && part, the one that runs the tests', () => {
    expect(posix('npm run build && npx vitest run', {}, F)).toBe(`npm run build && npx vitest run ${Q}`);
  });

  it('hands them to an npm script that is the runner alone, after --', () => {
    expect(posix('npm test', { test: 'vitest run' }, F)).toBe(`npm test -- ${Q}`);
    expect(posix('npm test -- --reporter=json', { test: 'vitest run' }, F)).toBe(`npm test -- --reporter=json ${Q}`);
    expect(posix('npm run unit', { unit: 'pytest' }, F)).toBe(`npm run unit -- ${Q}`);
  });

  it('refuses whatever is not certain', () => {
    expect(posix('npx jest', {}, F)).toBeNull();
    expect(posix('npx vitest run | tee out', {}, F)).toBeNull();
    expect(posix('cd pkg && npx vitest run', {}, F)).toBeNull();
    expect(posix('npm test', { test: 'npm run build && vitest run' }, F)).toBeNull();
    expect(posix('npm test', { test: 'jest' }, F)).toBeNull();
    expect(posix('npm test -w packages/ui', { test: 'vitest run' }, F)).toBeNull();
    expect(posix('npx vitest run', {}, [])).toBeNull();
  });

  it('refuses a command that already names targets: the files could be ones it never runs', () => {
    expect(posix('pytest tests/unit', {}, F)).toBeNull();
    expect(posix('node --test test/unit', {}, F)).toBeNull();
    expect(posix('npx vitest run src', {}, F)).toBeNull();
    expect(posix('npx vitest run --reporter json', {}, F)).toBeNull();
    expect(posix('npm test -- src', { test: 'vitest run' }, F)).toBeNull();
    expect(posix('npm test', { test: 'pytest tests/unit' }, F)).toBeNull();
  });

  it('refuses a lone & or a line break: the files would go to another command', () => {
    expect(posix('npx vitest run & echo', {}, F)).toBeNull();
    expect(posix('npx vitest run\necho', {}, F)).toBeNull();
  });

  it('refuses a run already narrowed by git state or a shard', () => {
    expect(posix('npx vitest run --changed', {}, F)).toBeNull();
    expect(posix('npx vitest run --shard=1/3', {}, F)).toBeNull();
    expect(posix('pytest --lf', {}, F)).toBeNull();
  });
});

describe('withTestFiles on Windows (#208)', () => {
  const win = (command: string, scripts: Record<string, string>, files: readonly string[]) => withTestFiles(command, scripts, files, 'win32');
  const WF = ['src/a.test.ts', "it's.test.ts"];
  const WQ = `"src/a.test.ts" "it's.test.ts"`;

  it('double-quotes the files for cmd.exe, which reads single quotes as part of the name', () => {
    expect(win('npx vitest run --reporter=json', {}, WF)).toBe(`npx vitest run --reporter=json ${WQ}`);
    expect(win('npm run build && npx vitest run', {}, WF)).toBe(`npm run build && npx vitest run ${WQ}`);
    expect(win('npm test', { test: 'vitest run' }, WF)).toBe(`npm test -- ${WQ}`);
  });

  it('takes a runner named by a Windows path', () => {
    expect(win('node C:\\tools\\vitest.js run', {}, WF)).toBe(`node C:\\tools\\vitest.js run ${WQ}`);
    expect(win('C:\\py\\Scripts\\pytest --junitxml=r.xml', {}, WF)).toBe(`C:\\py\\Scripts\\pytest --junitxml=r.xml ${WQ}`);
  });

  it('refuses a file cmd.exe cannot carry inside quotes: a % expands, a " ends the quote', () => {
    expect(win('npx vitest run', {}, ['src/100%.test.ts'])).toBeNull();
    expect(win('npx vitest run', {}, ['src/"a".test.ts'])).toBeNull();
  });

  it("refuses cmd.exe's own operators in the command: the files would go to another command", () => {
    expect(win('npx vitest run | more', {}, WF)).toBeNull();
    expect(win('npx vitest run & echo', {}, WF)).toBeNull();
    expect(win('npx vitest run > out.txt', {}, WF)).toBeNull();
    expect(win('npx vitest run ^', {}, WF)).toBeNull();
    expect(win('npx vitest run %FILTER%', {}, WF)).toBeNull();
  });

  it('still refuses what is not certain on any platform', () => {
    expect(win('npx jest', {}, WF)).toBeNull();
    expect(win('cd pkg && npx vitest run', {}, WF)).toBeNull();
    expect(win('npx vitest run src', {}, WF)).toBeNull();
  });
});

describe('quoteArg', () => {
  it('is a POSIX single-quoted word off Windows', () => {
    expect(quoteArg("it's a.ts", 'linux')).toBe(`'it'\\''s a.ts'`);
    expect(quoteArg('C:\\x\\$y', 'darwin')).toBe(`'C:\\x\\$y'`);
  });

  it('is a double-quoted word on Windows, or null where cmd.exe cannot carry it', () => {
    expect(quoteArg("it's a.ts", 'win32')).toBe(`"it's a.ts"`);
    expect(quoteArg('src\\a b.test.ts', 'win32')).toBe(`"src\\a b.test.ts"`);
    expect(quoteArg('100%.ts', 'win32')).toBeNull();
    expect(quoteArg('a".ts', 'win32')).toBeNull();
    expect(quoteArg('a\nb', 'win32')).toBeNull();
  });
});
