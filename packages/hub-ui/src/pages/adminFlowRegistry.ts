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

// ── Tab labels ─────────────────────────────────────────────────────────────

export interface TabLabels {
  myFlows: string;
  registry: string;
}

/**
 * Labels the hub admin passes to the shared FlowEditorModal.
 *
 * The shared editor hardcodes "My Flows" / "Community", which is right for the
 * standalone agenfk client and wrong here. In the hub admin the first tab lists
 * the ORG's flow catalogue (`/v1/admin/flows`) — the one every installation
 * inherits — so "My" is misleading; and the second lists whatever
 * `resolveRegistryRead` resolves to, which after CGLAB-138 is the org's own
 * private repo for any org that configured one. A tab labelled "Community"
 * showing `cglab-PRIVATE/agenfk-flows` is not describing the thing it shows.
 */
export const DEFAULT_TAB_LABELS: TabLabels = {
  myFlows: 'Org Flows',
  registry: 'Community',
};

/** Longest registry label, so a long org/repo cannot push the second tab out
 * of the modal's two-button flex row. */
const MAX_REGISTRY_LABEL = 32;

/**
 * Resolve the registry tab's label from the org's current config.
 *
 * The repo slug wins over the `isPublic` flag wherever they disagree: the
 * server derives `isPublic` from the slug and the slug is what
 * `resolveRegistryRead` actually reads, so trusting the flag would let a
 * private repo be labelled "Community" — the exact bug this exists to prevent.
 * A missing config (still loading) yields "Community", the pre-CGLAB-138
 * wording, rather than an empty or half-formed label.
 */
export function resolveTabLabels(cfg: {
  isPublic?: boolean | null;
  repo?: string | null;
}): TabLabels {
  const repo = (cfg.repo ?? '').trim();
  const isPublic = repo === PUBLIC_REGISTRY_REPO
    ? true
    : repo === ''
      ? true // nothing resolved yet — fall back to the neutral wording
      : cfg.isPublic === true;
  return {
    myFlows: DEFAULT_TAB_LABELS.myFlows,
    registry: isPublic ? DEFAULT_TAB_LABELS.registry : truncateLabel(repo),
  };
}

function truncateLabel(value: string): string {
  if (value.length <= MAX_REGISTRY_LABEL) return value;
  // Keep the tail: the repo name identifies the registry far better than the
  // org prefix does, and every flow repo here shares the org.
  return `…${value.slice(-(MAX_REGISTRY_LABEL - 1))}`;
}

// ── Registry source selector ───────────────────────────────────────────────

/** Which registry the browse/install surface reads. Mirrors the server enum. */
export type RegistrySource = 'org' | 'community';

/**
 * Whether the source selector is worth showing.
 *
 * While the org is on the public registry, both sources resolve to the same
 * repo — the control would be two options that do the same thing, which reads
 * as a broken toggle. It only earns its space once a private repo exists to
 * choose between.
 */
export function showRegistrySourcePicker(cfg: {
  isPublic?: boolean | null;
  repo?: string | null;
}): boolean {
  const repo = (cfg.repo ?? '').trim();
  if (!repo || repo === PUBLIC_REGISTRY_REPO) return false;
  return cfg.isPublic !== true;
}

/**
 * The caption for the org option. Named for the repo it points at so the admin
 * can tell the two apart at a glance rather than trusting an abstract "Org".
 */
export function registrySourceOptions(cfg: {
  isPublic?: boolean | null;
  repo?: string | null;
}): Array<{ value: RegistrySource; label: string }> {
  const repo = (cfg.repo ?? '').trim() || 'Org registry';
  return [
    { value: 'org', label: repo === PUBLIC_REGISTRY_REPO ? 'This registry' : repo },
    { value: 'community', label: 'Community' },
  ];
}
