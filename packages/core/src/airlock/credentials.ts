/**
 * Credential stores under a user's home (GH-294): what layer 2 denies the
 * sandbox reads of. Each one is also a credential read layer 1 recognises in a
 * command (credentialPathsIn in ./shell); a test pins the two together so they
 * cannot drift. Home-relative, `*` as in a glob.
 */
export const HOME_CREDENTIAL_STORES: readonly string[] = Object.freeze([
  '.aws/credentials',
  '.aws/sso/cache',
  '.ssh/id_*',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.kube/config',
  '.config/gcloud',
  '.azure',
]);
