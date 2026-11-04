/**
 * Host-held logins (GH-356, decision 2026-11-04): a Claude Code or Codex session in the machine gets
 * a stand-in, and the launcher's injector (keyInjector.ts) puts the real token there on the way to
 * the inference host. The token comes from a TokenSource, the interface agreed with the software
 * factory (SPEC-043 PRX-5/6, SEC-6, MOD-6):
 *
 *   - pulled when needed, never pushed; cached per (provider, subject) until 60 s before expiresAt;
 *   - on an upstream 401 the injector invalidates it and asks once more;
 *   - Airlock never refreshes a login: the source does (one refresher per account). The local
 *     source reads the person's own Claude Code or Codex login, which that client on the host keeps fresh.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type TokenProvider = 'anthropic' | 'openai';

export interface TokenRequest {
  provider: TokenProvider;
  /** The person the session is for, not the machine's user. */
  subject: string;
  /** The factory's job and lease fence, passed through to its broker; the local source ignores them. */
  jobId?: string;
  fence?: number;
}

export interface Token { accessToken: string; expiresAt: number; accountId?: string; idToken?: string }

export interface TokenSource {
  get(req: TokenRequest): Promise<Token>;
  invalidate(req: TokenRequest, accessToken: string): Promise<void>;
}

export type TokenErrorCode = 'not_connected' | 'at_limit' | 'revoked';

export class TokenSourceError extends Error {
  constructor(public readonly code: TokenErrorCode, public readonly resetAt?: number, detail?: string) {
    super(detail ?? code);
    this.name = 'TokenSourceError';
  }
}

/** What a launch says when the source cannot give a token: what is wrong, and what to do. */
export function tokenErrorMessage(e: unknown, client: string): string {
  const code = (e as { code?: unknown })?.code;
  const detail = (e as Error)?.message && (e as Error).message !== code ? ` (${(e as Error).message})` : '';
  if (code === 'at_limit') {
    const at = (e as { resetAt?: unknown }).resetAt;
    const when = typeof at === 'number' && Number.isFinite(at) ? ` until ${new Date(at).toISOString()}` : '';
    return `The account this ${client} session would use is at its usage limit${when}, so nothing was launched.`;
  }
  if (code === 'revoked') return `The login this ${client} session would use was revoked${detail}. Log in again, then relaunch. Nothing was launched.`;
  const howToLogIn = client === 'codex' ? 'run codex login' : `run ${client}, then /login`;
  return `Your login is not connected${detail}, so this ${client} session has nothing to log in with and nothing was launched. ` +
    `Log in to ${client} on this machine (${howToLogIn}), or launch with --login mount, or set an API key.`;
}

/** How long before it expires a cached token is asked for again. */
export const TOKEN_EARLY_MS = 60_000;

/**
 * One (provider, subject)'s token, cached; what the injector holds for a stand-in. token(): the whole
 * of it, for what a stand-in login carries beside the token (Codex's account).
 */
export interface CachedToken { get(): Promise<string>; token(): Promise<Token>; invalidate(stale: string): Promise<void> }

export function cachedToken(source: TokenSource, req: TokenRequest, now: () => number = Date.now): CachedToken {
  let held: Token | null = null;
  let asking: Promise<Token> | null = null;
  const token = async (): Promise<Token> => {
    if (held && now() < held.expiresAt - TOKEN_EARLY_MS) return held;
    // Callers waiting together share one ask.
    asking ??= source.get(req).finally(() => { asking = null; });
    held = await asking;
    return held;
  };
  return {
    async get() { return (await token()).accessToken; },
    token,
    async invalidate(stale) {
      await source.invalidate(req, stale);
      // A token already replaced stays: the failure was the old one's.
      if (held?.accessToken === stale) held = null;
    },
  };
}

export interface LocalTokenSourceOptions {
  platform: NodeJS.Platform;
  home: string;
  /** CLAUDE_CONFIG_DIR when the user set one. */
  claudeConfigDir?: string;
  /** CODEX_HOME when the user set one. */
  codexHome?: string;
  /** A Keychain item's secret (macOS), or null. */
  readKeychain?: (service: string) => string | null;
}

/** Claude Code's macOS Keychain item. */
const CLAUDE_KEYCHAIN = 'Claude Code-credentials';
const MAX_LOGIN_BYTES = 64 * 1024;

function keychainSecret(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
}

function readLoginFile(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size <= MAX_LOGIN_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** A JWT's exp, in ms; null when the token is none. */
function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The person's Codex ChatGPT login, from its auth.json (b3a0992f). A login Codex keeps in the OS
 * keyring is not read: the file is what codex on the host keeps fresh beside it.
 */
function codexToken(codexHome: string): Token {
  const file = path.join(codexHome, 'auth.json');
  let tokens: { access_token?: unknown; account_id?: unknown } | undefined;
  try { tokens = JSON.parse(readLoginFile(file) ?? 'null')?.tokens; } catch { tokens = undefined; }
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new TokenSourceError('not_connected', undefined, `there is no Codex ChatGPT login in ${file} (a login kept in the OS keyring is not read: set cli_auth_credentials_store = "file" in config.toml and log in again)`);
  }
  const expiresAt = jwtExpiry(tokens.access_token) ?? Date.now() + TOKEN_EARLY_MS * 2;
  if (expiresAt <= Date.now()) {
    throw new TokenSourceError('not_connected', undefined, 'the Codex login on this machine has expired; open codex here once to refresh it');
  }
  return { accessToken: tokens.access_token, expiresAt, ...(typeof tokens.account_id === 'string' && tokens.account_id ? { accountId: tokens.account_id } : {}) };
}

/**
 * The person's own login on this machine. anthropic: Claude Code's (the Keychain on a Mac, its
 * .credentials.json elsewhere). openai: Codex's ChatGPT login, its auth.json (CODEX_HOME's).
 */
export function localTokenSource(o: LocalTokenSourceOptions): TokenSource {
  const readLogin = (): string | null => {
    if (o.platform === 'darwin') return (o.readKeychain ?? keychainSecret)(CLAUDE_KEYCHAIN);
    return readLoginFile(path.join(o.claudeConfigDir ?? path.join(o.home, '.claude'), '.credentials.json'));
  };
  return {
    async get(req) {
      if (req.provider === 'openai') return codexToken(o.codexHome ?? path.join(o.home, '.codex'));
      let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
      try { oauth = JSON.parse(readLogin() ?? 'null')?.claudeAiOauth; } catch { oauth = undefined; }
      if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) throw new TokenSourceError('not_connected');
      const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Date.now() + TOKEN_EARLY_MS * 2;
      if (expiresAt <= Date.now()) {
        throw new TokenSourceError('not_connected', undefined, 'the Claude Code login on this machine has expired; open claude here once to refresh it');
      }
      return { accessToken: oauth.accessToken, expiresAt };
    },
    // Nothing to drop: the next get reads the login again, as the client on the host left it.
    async invalidate() { /* the local login is its client's to refresh */ },
  };
}
