/**
 * d26832d6 #1 — an entry capture that RAN and could not be used is not a card
 * that predates checks. On marketing-lab the first run dirtied its own tree,
 * its results were discarded, and every red/green check of the next step
 * passed soft on nothing. Soft stays for a project that records no per-test
 * results at all (its hold is entry-baseline's), never for a failed capture.
 */
import { describe, it, expect } from 'vitest';
import { EVALUATORS, evaluateChecks, type EngineContext, type CaptureRecord } from '../checkEngine';

type T = { name: string; file: string; status: 'passed' | 'failed' | 'skipped' };
const t = (name: string, status: T['status']): T => ({ name: `a.test.js > ${name}`, file: 'a.test.js', status });
const cap = (tests: T[] | null, over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  step: 'S', exitCode: 0, format: 'junit-xml', available: tests !== null, ...(tests ? { tests } : {}), brokenFiles: [],
  surface: { files: {} }, surfaceComplete: true, surfaceScope: 'declared', surfaceDeclared: [], ...over,
} as CaptureRecord);
const ctx = (entry: CaptureRecord | null, now: T[]): EngineContext => ({
  root: '/repo', git: () => '', item: { id: 'A', type: 'TASK' }, cardBranch: null, cardKeys: [], testPaths: [], ignoredPaths: [],
  foreignClaims: [], deferToCommand: [], children: [], capture: cap(now), entry, entryHead: null, records: {},
} as unknown as EngineContext);

const NOW = [t('adds', 'passed'), t('multiplies', 'failed')];
const FAILED_ENTRY = cap(null, { parseError: 'could not use the junit-xml report at .reports/r.xml: the tree changed while the command ran, so the results cannot be tied to it' });

describe('a failed entry capture holds the card', () => {
  for (const id of ['some-new-test-red', 'new-tests-exist', 'existing-tests-still-green', 'test-set-identical']) {
    it(`${id} blocks when the entry capture failed`, () => {
      const r = EVALUATORS[id](ctx(FAILED_ENTRY, NOW), {});
      expect(r.outcome).toBe('unavailable');
      expect((r as any).soft).toBeFalsy();
      expect(r.detail).toMatch(/tree changed while the command ran/);
    });
  }

  it('the engine reports it as blocking, and the card is held', () => {
    const out = evaluateChecks([{ id: 'some-new-test-red', step: 'S', source: 'role', severity: 'block', params: {}, applicable: true } as any], ctx(FAILED_ENTRY, NOW));
    expect(out.blocked).toBe(true);
    expect(out.results[0]).toMatchObject({ outcome: 'unavailable', blocking: true });
  });

  it('a project that records no per-test results at all stays soft (entry-baseline holds it instead)', () => {
    const noReport = cap(null, { format: 'exit-code' });
    const r = EVALUATORS['some-new-test-red'](ctx(noReport, NOW), {});
    expect(r.outcome).toBe('unavailable');
    expect((r as any).soft).toBe(true);
  });
});
