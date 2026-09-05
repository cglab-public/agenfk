import { describe, it, expect } from 'vitest';
import {
  PUBLIC_REGISTRY_REPO,
  isValidRegistrySlug,
  registryFormError,
  registrySaveLabel,
  MOVE_BACK_TO_PUBLIC_CONFIRM,
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
