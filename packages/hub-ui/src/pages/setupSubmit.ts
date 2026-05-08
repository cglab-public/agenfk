/**
 * Subtask 5daa24df — Setup page must POST a `token` field alongside email +
 * password so the hub's token-gated /setup/initial-admin route accepts it.
 *
 * Extracted from the JSX so the body-shape contract is testable in isolation.
 */
export interface SetupFields {
  token: string;
  email: string;
  password: string;
}

/**
 * Whitespace-trim the token so an operator who copy-pasted the boxed banner
 * doesn't fail validation because of a stray space. Email + password are
 * passed through unchanged — the server is the authority on those.
 */
export function buildSetupPayload(fields: SetupFields): SetupFields {
  return {
    token: fields.token.trim(),
    email: fields.email,
    password: fields.password,
  };
}

/**
 * The submit button is enabled only when all three fields look minimally
 * sane and we're not already submitting. Server still owns final validation.
 */
export function canSubmitSetup(args: SetupFields & { isPending: boolean }): boolean {
  if (args.isPending) return false;
  if (args.token.trim().length === 0) return false;
  if (args.email.length === 0) return false;
  if (args.password.length < 8) return false;
  return true;
}
