/**
 * The header's running verifies (3aea49f1, CGLAB-430): when one is worth
 * showing, and what its phase says. Kept out of the component so it exports
 * components only.
 */
import type { VerifyRunPhase } from './types';

/** A verify shows once it has run this long: a quick one is not worth the header. */
export const VERIFY_RUNS_THRESHOLD_MS = 10_000;

/** What a phase says, in the list. */
export function phaseText(phase: VerifyRunPhase | undefined): string {
  switch (phase?.state) {
    case 'queued': return `waiting for a suite-run slot: ${phase.ahead} ahead`;
    case 'awaiting-person': return 'waiting on a person';
    case 'running':
      if (phase.kind === 'affected') return `affected tests only: ${phase.files ?? '?'} files`;
      if (phase.kind === 'tests-only') return `changed test files only: ${phase.files ?? '?'}`;
      if (phase.kind === 'reused') return 'reusing an earlier green run';
      return 'running the whole suite';
    default: return 'running the step\'s checks';
  }
}

/** The query the list lives in: GET /verify-runs, replaced by each 'verify_runs' push. */
export const VERIFY_RUNS_QUERY_KEY = ['verify-runs'];
