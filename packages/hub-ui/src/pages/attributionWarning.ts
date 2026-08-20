// Phantom-identity detection for the admin installations table (task 962aa31e).
//
// The hub attributes every event with `userKeyFor = gitEmail?.toLowerCase() ||
// osUser` (packages/hub/src/routes/events.ts). An installation with no
// `git config user.email` is therefore filed on every dashboard under an OS
// username instead of a person — and if that person later sets their git email
// they silently become a SECOND identity, with the CGLAB-65 identity merge as
// the only way back.
//
// Nothing surfaced this before: an admin had to notice an empty email column.

export interface AttributableRowLike {
  gitEmail: string | null;
  osUser: string | null;
}

/** Is this install's history filed under a username rather than a person? */
export function isAttributedByUsername(row: AttributableRowLike): boolean {
  return !row.gitEmail || !row.gitEmail.trim();
}

/** How many installs in the fleet are affected — drives the summary line. */
export function countAttributedByUsername(rows: AttributableRowLike[]): number {
  return rows.reduce((n, r) => (isAttributedByUsername(r) ? n + 1 : n), 0);
}

/**
 * Copy for the warning. It has to name the consequence: "git email not set" is
 * a fact an admin can read off the table already, whereas "this person's work is
 * filed under a username and will split in two if they fix it later" is the part
 * that makes them act.
 */
export function attributionWarning(osUser: string | null): string {
  const who = osUser && osUser.trim() ? osUser.trim() : 'this machine';
  return (
    `No git email configured, so events from ${who} are attributed to the OS username ` +
    `rather than a person. Metrics and dashboards will show it as a separate identity, ` +
    `and setting user.email later creates a second one that has to be merged. ` +
    `Fix at the source with: git config --global user.email "you@company.com".`
  );
}
