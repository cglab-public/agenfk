/**
 * A Codex ChatGPT login held on the host (b3a0992f, GH-356 follow-up). The machine's own auth.json is a
 * stand-in, in the shape spike 2144721a measured codex to start from: a JWT-shaped id_token (three parts,
 * a signature segment that is not empty; its claims may be empty), an opaque access token, any refresh
 * token, the real account_id - chatgpt-account-id is sent from it alone - and last_refresh.
 *
 * The access token is a placeholder the injector swaps for the TokenSource's token toward chatgpt.com.
 * codex refreshes by itself (after a second 401 in a row) by POSTing its refresh token to
 * auth.openai.com/oauth/token and writing the reply into auth.json: the host answers that itself, and
 * the stand-in refresh token never leaves it.
 */
import { loginRefusal, type LocalAnswer } from './keyInjector';

/** The machine's placeholder names for the stand-in's tokens (beside its env vars' placeholders). */
export const CODEX_ACCESS_PLACEHOLDER = 'AGENFK_CODEX_ACCESS_TOKEN';
export const CODEX_REFRESH_PLACEHOLDER = 'AGENFK_CODEX_REFRESH_TOKEN';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A JWT in shape only: no claims (no exp, so codex never refreshes it by itself), a signature nobody checks. */
export function standInIdToken(): string {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({})}.${Buffer.from('airlock-stand-in').toString('base64url')}`;
}

export function codexStandInAuth(o: { accessToken: string; refreshToken: string; accountId: string; now?: number }): string {
  if (!o.accountId) throw new Error('A Codex stand-in login needs the account it is for: chatgpt.com routes the workspace by it.');
  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: standInIdToken(), access_token: o.accessToken, refresh_token: o.refreshToken, account_id: o.accountId },
    last_refresh: new Date(o.now ?? Date.now()).toISOString(),
  }, null, 2)}\n`;
}

/** Where codex refreshes its login (its CODEX_REFRESH_TOKEN_URL default). */
const TOKEN_PATH = '/oauth/token';

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body), contentType: 'application/json' });

/**
 * The host's answer on codex's login host: a refresh carrying the stand-in refresh token invalidates
 * the held token and asks once more (the source refreshes, never Airlock), then replies with the same
 * stand-ins - the injector keeps swapping them. Anything else there is refused: no login runs inside.
 */
export function codexTokenAnswer(o: {
  token: { get(): Promise<string>; invalidate(stale: string): Promise<void> };
  accessToken: string;
  refreshToken: string;
}): LocalAnswer {
  return async (req) => {
    if (req.method !== 'POST' || new URL(req.path, 'http://x').pathname !== TOKEN_PATH) {
      return json(403, { error: 'forbidden', error_description: 'Airlock holds this login on the host: nothing but a token refresh is answered here.' });
    }
    let body: { refresh_token?: unknown };
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return json(400, { error: 'invalid_request' }); }
    if (body?.refresh_token !== o.refreshToken) return json(401, { error: 'invalid_grant' });
    try {
      await o.token.invalidate(await o.token.get());
      await o.token.get();
    } catch (e) {
      // Never a 401: codex would tell the person to log in again inside the machine. Its code only:
      // a source's message may carry a token (review).
      return { status: 502, body: loginRefusal(e), contentType: 'text/plain' };
    }
    return json(200, { id_token: standInIdToken(), access_token: o.accessToken, refresh_token: o.refreshToken });
  };
}
