import { describe, it, expect } from 'vitest';
import {
  PUBLIC_REGISTRY_REPO,
  isValidRegistrySlug,
  registryFormError,
  registrySaveLabel,
  registryConfigSaveLabel,
  MOVE_BACK_TO_PUBLIC_CONFIRM,
  EDITOR_LABELS_HUB,
} from '../pages/adminFlowRegistry';
import { isValidRegistrySlug as serverIsValidRegistrySlug } from '../../../hub/src/services/flowRegistry.js';

describe('admin flow registry form (CGLAB-138)', () => {
  it('accepts a normal private repo', () => {
    expect(isValidRegistrySlug('acme-corp/agenfk-flows')).toBe(true);
  });

  it('rejects shapes that are not owner/repo', () => {
    for (const bad of ['', 'noslash', 'a/b/c', 'a/', '/b', 'own er/repo', 'owner/repo;rm -rf /']) {
      expect(isValidRegistrySlug(bad), bad).toBe(false);
    }
  });

  it('agrees with the SERVER validator on the same corpus', () => {
    // The two implementations must not drift: a UI that accepts what the
    // server rejects shows a spinner then an error for no reason.
    const corpus = [
      'acme/flows', 'acme-corp/agenfk-flows', 'a.b/c_d-1', 'PUBLIC/Repo',
      '-evil/repo', 'owner/-evil', 'own er/repo', 'owner/repo;rm -rf /',
      'a/b/c', 'a/', '/b', 'noslash', '', '..', 'a/../../b',
    ];
    for (const c of corpus) {
      expect(isValidRegistrySlug(c), c).toBe(serverIsValidRegistrySlug(c));
    }
  });

  it('requires a token for a private repo when none is stored', () => {
    expect(registryFormError({ repo: 'acme/flows', token: '', hasStoredToken: false }))
      .toMatch(/token/i);
  });

  it('does NOT require retyping a token that is already stored', () => {
    // The server never echoes the secret back, so the UI has nothing to resend.
    expect(registryFormError({ repo: 'acme/flows', token: '', hasStoredToken: false })).toBeTruthy();
    expect(registryFormError({ repo: 'acme/flows', token: '', hasStoredToken: true })).toBeNull();
  });

  it('does not require a token for the public repo', () => {
    expect(registryFormError({ repo: PUBLIC_REGISTRY_REPO, token: '', hasStoredToken: false })).toBeNull();
  });

  it('rejects a bad slug before complaining about the token', () => {
    const err = registryFormError({ repo: 'not-a-slug', token: '', hasStoredToken: false });
    expect(err).toMatch(/owner\/repo/);
  });

  it('labels the private-repo save as a copy, the public one plainly', () => {
    expect(registrySaveLabel({ repo: 'acme/flows', token: 'x', hasStoredToken: false }))
      .toMatch(/copy/i);
    expect(registrySaveLabel({ repo: PUBLIC_REGISTRY_REPO, token: '', hasStoredToken: true }))
      .toBe('Save');
  });

  it('warns on moving back to public that installs re-read the public repo', () => {
    expect(MOVE_BACK_TO_PUBLIC_CONFIRM).toMatch(/public/i);
  });
});

// ── Mutant-killers ─────────────────────────────────────────────────────────
describe('admin flow registry form — edge branches', () => {
  it('trims the repo before deciding, so whitespace does not change the verdict', () => {
    // Survived: `state.repo.trim()` → `state.repo`. A pasted value with a
    // trailing space is the common case, and without the trim it reads as a
    // private repo (showing "Save & copy") or as an invalid slug.
    expect(registryFormError({ repo: '  acme/flows  ', token: 'ghp_x', hasStoredToken: false })).toBeNull();
    expect(registrySaveLabel({ repo: '  acme/flows  ', token: '', hasStoredToken: true }))
      .toMatch(/copy/i);
    expect(registrySaveLabel({ repo: '  ' + PUBLIC_REGISTRY_REPO + '  ', token: '', hasStoredToken: true }))
      .toBe('Save');
  });

  it('treats a whitespace-only token as no token', () => {
    // Survived: `state.token.trim()` → `state.token`. A field of spaces would
    // otherwise satisfy the requirement and the save would fail server-side.
    expect(registryFormError({ repo: 'acme/flows', token: '   ', hasStoredToken: false }))
      .toMatch(/token/i);
  });

  it('reports the empty-repo message rather than the slug message', () => {
    // Survived: ConditionalExpression → false on `if (!repo)`. Removing it
    // still rejects, but with the wrong sentence for an untouched field.
    expect(registryFormError({ repo: '', token: '', hasStoredToken: true })).toMatch(/Enter the owner\/repo/);
    expect(registryFormError({ repo: '   ', token: '', hasStoredToken: true })).toMatch(/Enter the owner\/repo/);
  });

  it('does not ask for a token when the repo is public even with none stored', () => {
    // The third clause of the conjunction: hasStoredToken false + public repo
    // must still pass, which only holds if toPublic short-circuits it.
    expect(registryFormError({ repo: PUBLIC_REGISTRY_REPO, token: '', hasStoredToken: false })).toBeNull();
  });

  it('labels an empty repo plainly rather than as a copy', () => {
    // Survived: `repo &&` in registrySaveLabel. Without the guard an empty
    // field would advertise "Save & copy community flows" on a disabled button.
    expect(registrySaveLabel({ repo: '', token: '', hasStoredToken: false })).toBe('Save');
  });

  it('keeps the two error messages distinct', () => {
    // Two different problems must not collapse into one string, or the admin
    // cannot tell an empty field from a malformed one.
    const empty = registryFormError({ repo: '', token: '', hasStoredToken: true });
    const bad = registryFormError({ repo: 'nope', token: '', hasStoredToken: true });
    const token = registryFormError({ repo: 'acme/flows', token: '', hasStoredToken: false });
    expect(new Set([empty, bad, token]).size).toBe(3);
  });
});

// ── Editor footer labels ───────────────────────────────────────────────────
//
// The three footer CTAs read as one pipeline (Save → Publish → Use this Flow)
// when they are three unrelated writes. These pin the hub-admin wording.
describe('EDITOR_LABELS_HUB', () => {
  it('says Save is the publish, because saving the row is what fans it out', () => {
    expect(EDITOR_LABELS_HUB.save).toMatch(/save/i);
    expect(EDITOR_LABELS_HUB.save).toMatch(/publish/i);
    expect(EDITOR_LABELS_HUB.save).toMatch(/org/i);
  });

  it('names the assignment the button actually writes, not "use"', () => {
    // The button only writes a flow_assignments row for the id it already has,
    // so "Use this Flow" promises an action it does not take.
    expect(EDITOR_LABELS_HUB.useFlow).toMatch(/org default/i);
  });

  it('does not reuse the word "publish" for the assignment button', () => {
    // Two buttons claiming to publish is the confusion this removes.
    expect(EDITOR_LABELS_HUB.useFlow).not.toMatch(/publish/i);
  });

  it('labels the two editor buttons differently', () => {
    expect(EDITOR_LABELS_HUB.save).not.toBe(EDITOR_LABELS_HUB.useFlow);
  });

  it('gives the confirmation its own caption, past-tensed by the host not by rule', () => {
    // Appending "d" to the save caption would render "Save & publish to orgd".
    expect(EDITOR_LABELS_HUB.saved).toBeTruthy();
    expect(EDITOR_LABELS_HUB.saved).not.toBe(`${EDITOR_LABELS_HUB.save}d`);
    expect(EDITOR_LABELS_HUB.saved).toMatch(/publish/i);
  });

  it('matches the badge the flows list renders for the same assignment', () => {
    // AdminFlows renders an "Org default" badge on the row this button sets.
    // Substring, not equality: the button is a verb phrase, the badge a noun.
    expect(EDITOR_LABELS_HUB.useFlow.toLowerCase()).toContain('org default');
  });
});

// ── Two "Save" buttons on one page ─────────────────────────────────────────
// Admin → Flows renders the flow editor's Save and the registry-config form's
// Save. Both said "Save". They write unrelated things.
describe('registryConfigSaveLabel', () => {
  it('names the registry form plainly, so it is not the editor save', () => {
    expect(registryConfigSaveLabel({ repo: PUBLIC_REGISTRY_REPO, token: '', hasStoredToken: true }))
      .toBe('Save registry repo');
  });

  it('keeps the copy warning when the target is private', () => {
    // The slow part still has to be advertised; only the plain case is renamed.
    expect(registryConfigSaveLabel({ repo: 'acme/flows', token: 'x', hasStoredToken: false }))
      .toMatch(/copy/i);
  });

  it('never collapses back onto the editor save label', () => {
    expect(registryConfigSaveLabel({ repo: '', token: '', hasStoredToken: false }))
      .not.toBe(EDITOR_LABELS_HUB.save);
    expect(registryConfigSaveLabel({ repo: '', token: '', hasStoredToken: false }))
      .not.toBe('Save');
  });

  it('is distinct from the editor label for every repo state', () => {
    for (const repo of ['', '   ', PUBLIC_REGISTRY_REPO, 'acme/flows', '  acme/flows  ']) {
      expect(registryConfigSaveLabel({ repo, token: '', hasStoredToken: true }), repo)
        .not.toBe(EDITOR_LABELS_HUB.save);
    }
  });
});
