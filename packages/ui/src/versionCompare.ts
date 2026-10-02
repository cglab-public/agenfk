/**
 * "Is there a newer version" — asked in one place.
 *
 * This lived inside `ReleaseReminder.tsx` as a file-local function. The
 * settings screen asks the same question, and the obvious move — write the
 * comparison again beside the new caller — produces two functions that agree
 * until they do not. The visible failure is specific and silly: the reminder
 * rocket lights up in the corner while the settings row two clicks away says
 * "You're up to date".
 */

/**
 * Is `latest` newer than `current`?
 *
 * The pre-release suffix is deliberately ignored, and that behaviour is
 * inherited rather than invented: a beta of the version you already run is not
 * an upgrade worth offering, while `1.2.0-beta.1` against `1.1.18` is.
 *
 * Answers `false` for anything it cannot compare. The release query goes to the
 * network and may never answer, and "no update" is the safe reading of "we do
 * not know" — the settings row says the same thing a different way, by
 * declining to claim you are up to date until it has been told.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!latest || !current) return false;

  const parts = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const l = parts(latest);
  const c = parts(current);

  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}
