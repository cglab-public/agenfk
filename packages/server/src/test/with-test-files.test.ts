/**
 * @file acceaa54 — which report commands can be told to run only some files.
 * Only where the runner's file arguments are certain; anything else is null,
 * and the capture runs the whole suite.
 */
import { describe, it, expect } from 'vitest';
import { withTestFiles } from '../testReportHint';

const F = ['src/a.test.ts', "it's.test.ts"];
const Q = `'src/a.test.ts' 'it'\\''s.test.ts'`;

describe('withTestFiles', () => {
  it('appends the files, quoted, to a runner that takes them', () => {
    expect(withTestFiles('npx vitest run --reporter=json', {}, F)).toBe(`npx vitest run --reporter=json ${Q}`);
    expect(withTestFiles('pytest --junitxml=r.xml', {}, F)).toBe(`pytest --junitxml=r.xml ${Q}`);
    expect(withTestFiles('node --test --test-reporter=junit', {}, F)).toBe(`node --test --test-reporter=junit ${Q}`);
  });

  it('puts them after the last && part, the one that runs the tests', () => {
    expect(withTestFiles('npm run build && npx vitest run', {}, F)).toBe(`npm run build && npx vitest run ${Q}`);
  });

  it('hands them to an npm script that is the runner alone, after --', () => {
    expect(withTestFiles('npm test', { test: 'vitest run' }, F)).toBe(`npm test -- ${Q}`);
    expect(withTestFiles('npm test -- --reporter=json', { test: 'vitest run' }, F)).toBe(`npm test -- --reporter=json ${Q}`);
    expect(withTestFiles('npm run unit', { unit: 'pytest' }, F)).toBe(`npm run unit -- ${Q}`);
  });

  it('refuses whatever is not certain', () => {
    expect(withTestFiles('npx jest', {}, F)).toBeNull();
    expect(withTestFiles('npx vitest run | tee out', {}, F)).toBeNull();
    expect(withTestFiles('cd pkg && npx vitest run', {}, F)).toBeNull();
    expect(withTestFiles('npm test', { test: 'npm run build && vitest run' }, F)).toBeNull();
    expect(withTestFiles('npm test', { test: 'jest' }, F)).toBeNull();
    expect(withTestFiles('npm test -w packages/ui', { test: 'vitest run' }, F)).toBeNull();
    expect(withTestFiles('npx vitest run', {}, [])).toBeNull();
  });

  it('refuses a command that already names targets: the files could be ones it never runs', () => {
    expect(withTestFiles('pytest tests/unit', {}, F)).toBeNull();
    expect(withTestFiles('node --test test/unit', {}, F)).toBeNull();
    expect(withTestFiles('npx vitest run src', {}, F)).toBeNull();
    expect(withTestFiles('npx vitest run --reporter json', {}, F)).toBeNull();
    expect(withTestFiles('npm test -- src', { test: 'vitest run' }, F)).toBeNull();
    expect(withTestFiles('npm test', { test: 'pytest tests/unit' }, F)).toBeNull();
  });

  it('refuses a lone & or a line break: the files would go to another command', () => {
    expect(withTestFiles('npx vitest run & echo', {}, F)).toBeNull();
    expect(withTestFiles('npx vitest run\necho', {}, F)).toBeNull();
  });

  it('refuses a run already narrowed by git state or a shard', () => {
    expect(withTestFiles('npx vitest run --changed', {}, F)).toBeNull();
    expect(withTestFiles('npx vitest run --shard=1/3', {}, F)).toBeNull();
    expect(withTestFiles('pytest --lf', {}, F)).toBeNull();
  });
});
