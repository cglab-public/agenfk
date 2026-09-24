/**
 * What a harness run says, and the exit code a caller can trust.
 *
 * Every scenario reports the outcome it expected and the one it got. Any
 * mismatch, any scenario that threw (`actual: 'error'`), and a run where
 * nothing ran at all fail the run: a harness that quietly runs zero scenarios
 * would otherwise look exactly like a green one.
 */
export function evaluate(results) {
  if (!results.length) {
    return { exitCode: 1, summary: 'FAILED: no scenarios ran - the harness is broken, not green.', lines: [] };
  }
  const lines = results.map(r => {
    const good = r.actual === r.expected;
    const why = r.detail ? ` - ${String(r.detail).replace(/\s+/g, ' ').slice(0, 300)}` : '';
    return good
      ? `  ok    ${r.check.padEnd(26)} ${r.scenario} (${r.actual})`
      : `  FAIL  ${r.check.padEnd(26)} ${r.scenario}: expected ${r.expected}, got ${r.actual}${why}`;
  });
  const passed = results.filter(r => r.actual === r.expected).length;
  const summary = `${passed} of ${results.length} scenarios as expected`;
  return { exitCode: passed === results.length ? 0 : 1, summary: passed === results.length ? summary : `FAILED: ${summary}`, lines };
}
