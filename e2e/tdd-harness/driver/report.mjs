/**
 * What a harness run says, and the exit code a caller can trust.
 *
 * Every scenario reports the outcome it expected and the one it got. Any
 * mismatch, any scenario that threw (`actual: 'error'`), and a run where
 * nothing ran at all fail the run: a harness that quietly runs zero scenarios
 * would otherwise look exactly like a green one.
 */
const REFUSING = new Set(['fail', 'warn', 'unavailable', 'unavailable-soft', 'refused', 'overridden']);

/**
 * The coverage table (T6): per catalogue check, the outcomes scenarios saw as
 * expected. A check never seen passing, or never seen refusing, is a hole in
 * the harness. Rows for things that are not checks (overrides, the full
 * cycle) are left out of it.
 */
export function coverage(results, catalogue) {
  const rows = catalogue.map(check => ({
    check,
    outcomes: [...new Set(results.filter(r => r.check === check && r.actual === r.expected).map(r => r.actual))].sort(),
  }));
  const gaps = rows.flatMap(({ check, outcomes }) =>
    !outcomes.length ? [`${check}: never exercised`]
      : !outcomes.includes('pass') ? [`${check}: never seen passing`]
      : !outcomes.some(o => REFUSING.has(o)) ? [`${check}: never seen refusing`] : []);
  return { rows, gaps };
}

export function evaluate(results, { catalogue } = {}) {
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
  let summary = `${passed} of ${results.length} scenarios as expected`;
  let ok = passed === results.length;
  const out = {};
  if (catalogue) {
    const { rows, gaps } = coverage(results, catalogue);
    lines.push('', `  Coverage (${catalogue.length} checks):`, ...rows.map(r => `    ${r.check.padEnd(28)} ${r.outcomes.join(', ') || '-'}`));
    if (gaps.length) lines.push('', '  Coverage gaps:', ...gaps.map(g => `    ${g}`));
    summary += gaps.length ? `; ${gaps.length} check(s) not fully covered` : `; all ${catalogue.length} checks covered`;
    ok = ok && !gaps.length;
    Object.assign(out, { coverage: rows, gaps });
  }
  return { exitCode: ok ? 0 : 1, summary: ok ? summary : `FAILED: ${summary}`, lines, ...out };
}
