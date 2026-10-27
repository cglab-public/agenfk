/**
 * Airlock (GH-294): the credential stores layer 2 denies to the sandbox are the
 * ones layer 1 recognises in a command, so the two lists cannot drift.
 */
import { describe, it, expect } from 'vitest';
import { HOME_CREDENTIAL_STORES } from '../airlock';
import { credentialPathsIn } from '../airlock/shell';

describe('HOME_CREDENTIAL_STORES', () => {
  it('names every credential store the review asked for', () => {
    for (const p of ['.aws/credentials', '.aws/sso/cache', '.ssh/id_*', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
      '.docker/config.json', '.kube/config', '.config/gcloud', '.azure']) {
      expect(HOME_CREDENTIAL_STORES).toContain(p);
    }
  });

  it('every entry is one layer 1 recognises as a credential read', () => {
    for (const p of HOME_CREDENTIAL_STORES) {
      expect(credentialPathsIn(`cat ~/${p.replace('*', 'ed25519')}/x`), p).not.toEqual([]);
    }
  });
});
