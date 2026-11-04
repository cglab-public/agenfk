/**
 * Host-held logins (GH-356, decision 2026-11-04): a Claude Code or Codex session in the machine gets
 * a stand-in, and the launcher's injector (keyInjector.ts) puts the real token there on the way to
 * the inference host. The token comes from a TokenSource, the interface agreed with the software
 * factory (SPEC-043 PRX-5/6, SEC-6, MOD-6):
 *
 *   - pulled when needed, never pushed; cached per (provider, subject) until 60 s before expiresAt;
 *   - on an upstream 401 the injector invalidates it and asks once more;
 *   - Airlock never refreshes a login: the source does (one refresher per account). The local
 *     source reads the person's own Claude Code login, which Claude Code on the host keeps fresh.
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
  return `Your login is not connected${detail}, so this ${client} session has nothing to log in with and nothing was launched. ` +
    `Log in to ${client} on this machine (run ${client}, then /login), or launch with --login mount, or set an API key.`;
}

/** How long before it expires a cached token is asked for again. */
export const TOKEN_EARLY_MS = 60_000;

/** One (provider, subject)'s token, cached; what the injector holds for a stand-in. */
export interface CachedToken { get(): Promise<string>; invalidate(stale: string): Promise<void> }

export function cachedToken(source: TokenSource, req: TokenRequest, now: () => number = Date.now): CachedToken {
  let held: Token | null = null;
  let asking: Promise<Token> | null = null;
  return {
    async get() {
      if (held && now() < held.expiresAt - TOKEN_EARLY_MS) return held.accessToken;
      // Callers waiting together share one ask.
      asking ??= source.get(req).finally(() => { asking = null; });
      held = await asking;
      return held.accessToken;
    },
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

/**
 * The person's own login on this machine. anthropic: Claude Code's (the Keychain on a Mac, its
 * .credentials.json elsewhere). openai: none yet - host-held Codex is a later story.
 */
export function localTokenSource(o: LocalTokenSourceOptions): TokenSource {
  const readLogin = (): string | null => {
    if (o.platform === 'darwin') return (o.readKeychain ?? keychainSecret)(CLAUDE_KEYCHAIN);
    const file = path.join(o.claudeConfigDir ?? path.join(o.home, '.claude'), '.credentials.json');
    try {
      const st = fs.statSync(file);
      return st.isFile() && st.size <= MAX_LOGIN_BYTES ? fs.readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  };
  return {
    async get(req) {
      if (req.provider !== 'anthropic') throw new TokenSourceError('not_connected', undefined, `no ${req.provider} login is held on this machine yet`);
      let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
      try { oauth = JSON.parse(readLogin() ?? 'null')?.claudeAiOauth; } catch { oauth = undefined; }
      if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) throw new TokenSourceError('not_connected');
      const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Date.now() + TOKEN_EARLY_MS * 2;
      if (expiresAt <= Date.now()) {
        throw new TokenSourceError('not_connected', undefined, 'the Claude Code login on this machine has expired; open claude here once to refresh it');
      }
      return { accessToken: oauth.accessToken, expiresAt };
    },
    // Nothing to drop: the next get reads the login again, as Claude Code on the host left it.
    async invalidate() { /* the local login is Claude Code's to refresh */ },
  };
}
