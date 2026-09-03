/**
 * Helpers for the admin Organization → Rename UI. Pure logic so the
 * existing hub-ui test convention (no RTL) keeps working.
 *
 * The regex MUST stay in lockstep with packages/hub/src/routes/orgRename.ts —
 * the server is the source of truth, but pre-validating in the UI saves a
 * round-trip and lets us show an inline message before the user clicks.
 */
export const ORG_ID_RENAME_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function validateOrgIdInput(candidate: string, current: string): string | null {
  const v = (candidate ?? '').trim();
  if (!v) return 'Enter a new org id (required).';
  if (v === current) return 'New id must be different from the current one.';
  if (!ORG_ID_RENAME_REGEX.test(v)) {
    return 'Invalid format: lowercase letters, digits and dashes only; 2–63 chars; must not start with a dash.';
  }
  return null;
}

export interface SpokeRepointArgs {
  hubUrl: string;
  orgId: string;
}

/**
 * Renders the canonical one-liner for spoke installations to point at the
 * renamed hub. The output is meant to be copyable as-is into a fleet runner
 * or terminal — both inputs flow through the strict server-side validation
 * on the way in, so we render them verbatim with no shell quoting.
 */
export function spokeRepointCommand(args: SpokeRepointArgs): string {
  const url = String(args.hubUrl).replace(/\/$/, '');
  // CGLAB-117: repoint only rewrites the outbox with --carry-over; the
  // campaign one-liner opts in explicitly so the admin rename flow stays
  // zero-touch-but-confirmed (the spoke still types the target org or passes
  // --yes in a fleet runner).
  return `agenfk hub repoint --url ${url} --org-id ${args.orgId} --carry-over`;
}
