/**
 * Validation for the admin "flow registry repo" form (CGLAB-138).
 *
 * Mirrors the server-side rules in packages/hub/src/services/flowRegistry.ts.
 * Duplicated on purpose rather than imported: the hub-ui bundle must not pull
 * in server code, and a browser-side rejection that disagrees with the server
 * is a UX bug, not a security hole — the server still refuses. Keep the two in
 * sync; the test asserts they agree on the same corpus.
 */

export const PUBLIC_REGISTRY_REPO = 'cglab-public/agenfk-flows';

/** Same charset as the server's GH_NAME_RE: no leading '-' (argv-flag safety),
 *  exactly one separator (no path traversal). */
const GH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function isValidRegistrySlug(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) return false;
  return parts.every((p) => GH_NAME_RE.test(p));
}

export interface RegistryFormState {
  repo: string;
  token: string;
  hasStoredToken: boolean;
}

/**
 * Why the form cannot be saved yet, or null when it can.
 *
 * The token rule is the important one: a private repo with no token is a
 * setting the server will reject, and the UI must not offer it. Note this only
 * asks about tokens the UI can actually see — if a token is already stored, the
 * admin is not required to retype it (the server never echoes it back).
 */
export function registryFormError(state: RegistryFormState): string | null {
  const repo = state.repo.trim();
  if (!repo) return 'Enter the owner/repo of an existing GitHub repository.';
  if (!isValidRegistrySlug(repo)) {
    return 'Must be "owner/repo" — letters, digits, dot, dash and underscore only.';
  }
  const toPublic = repo === PUBLIC_REGISTRY_REPO;
  if (!toPublic && !state.token.trim() && !state.hasStoredToken) {
    return 'A private registry needs a GitHub token with contents:write on that repo.';
  }
  return null;
}

/**
 * What the save button should say. Switching to a private repo copies flows,
 * which is the slow part of the operation — the label should say so rather
 * than looking like a metadata edit.
 */
export function registrySaveLabel(state: RegistryFormState): string {
  const repo = state.repo.trim();
  if (repo && repo !== PUBLIC_REGISTRY_REPO) return 'Save & copy community flows';
  return 'Save';
}

/**
 * Confirmation copy for moving back to the public registry. Worth an explicit
 * click: after this, the org's installs read the public repo again and any
 * private-only flows stop being offered.
 */
export const MOVE_BACK_TO_PUBLIC_CONFIRM =
  'Move this org back to the public community registry? Your private repo keeps its flows, but installations will browse the public one again.';
