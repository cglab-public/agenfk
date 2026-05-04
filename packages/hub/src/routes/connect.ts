import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { HubServerContext } from '../server.js';
import { requireSession, requireAdmin } from '../auth/session.js';
import { issueApiKey } from '../auth/apiKey.js';

// Plug-and-play hub onboarding endpoints — see the STORY for context.
//
// /hub/device/* implements an OAuth-style device-authorization flow so a dev
// can run `agenfk hub login --url <hub>` without ever copy-pasting a token.
// /hub/invite/* turns an admin-issued, HMAC-signed blob into a one-line
// `agenfk hub join <token>` command for offline distribution.

const DEVICE_CODE_TTL_S = 600;        // 10 minutes
const DEVICE_POLL_INTERVAL_S = 2;
const INVITE_TTL_MS = 14 * 86400_000; // 14 days

// Avoid look-alikes (0/O, 1/I, etc.) so users can read codes off a screen.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function userCode(): string {
  const buf = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[buf[i] % USER_CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function isoPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function publicHubUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim()
    || (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim()
    || req.headers.host
    || 'localhost';
  return `${proto}://${host}`;
}

function signInviteToken(payload: { orgId: string; nonce: string; exp: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyInviteToken(token: string, secret: string): { orgId: string; nonce: string; exp: number } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
    actual = Buffer.from(sigStr);
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed.orgId !== 'string' || typeof parsed.nonce !== 'string' || typeof parsed.exp !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function connectRouter(ctx: HubServerContext): Router {
  const router = Router();
  const guard = requireSession(ctx.config.sessionSecret);
  const adminGuard = requireAdmin(ctx.config.sessionSecret);

  // ── Device-code flow ──────────────────────────────────────────────────────

  router.post('/device/start', (req: Request, res: Response) => {
    const deviceCode = randomBytes(32).toString('base64url');
    let code = userCode();
    // Tiny retry loop on the (astronomically unlikely) UNIQUE collision.
    for (let i = 0; i < 5; i++) {
      const exists = ctx.db.prepare('SELECT 1 FROM device_codes WHERE user_code = ?').get(code);
      if (!exists) break;
      code = userCode();
    }
    ctx.db.prepare(
      `INSERT INTO device_codes (device_code, user_code, expires_at) VALUES (?, ?, ?)`
    ).run(deviceCode, code, isoPlus(DEVICE_CODE_TTL_S));
    res.json({
      deviceCode,
      userCode: code,
      verificationUri: `${publicHubUrl(req)}/connect?code=${code}`,
      expiresIn: DEVICE_CODE_TTL_S,
      interval: DEVICE_POLL_INTERVAL_S,
    });
  });

  router.post('/device/poll', (req: Request, res: Response) => {
    const { deviceCode } = req.body ?? {};
    if (typeof deviceCode !== 'string' || !deviceCode) { res.status(400).json({ error: 'deviceCode required' }); return; }
    const row = ctx.db.prepare(
      'SELECT org_id, token_hash, approved_at, expires_at FROM device_codes WHERE device_code = ?'
    ).get(deviceCode) as { org_id: string | null; token_hash: string | null; approved_at: string | null; expires_at: string } | undefined;
    if (!row) { res.status(404).json({ error: 'unknown device code' }); return; }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      res.json({ status: 'expired' });
      return;
    }
    if (!row.approved_at || !row.org_id) {
      res.json({ status: 'pending' });
      return;
    }
    // Approved: surface the issued token *exactly once*, then null it out so a
    // replay of /poll can't re-leak the bearer.
    const token = (ctx as any)._deviceTokens?.get(deviceCode);
    if (!token) { res.status(410).json({ error: 'token already retrieved' }); return; }
    (ctx as any)._deviceTokens.delete(deviceCode);
    res.json({
      status: 'approved',
      token,
      orgId: row.org_id,
      hubUrl: publicHubUrl(req),
    });
  });

  router.post('/device/approve', guard, (req: Request, res: Response) => {
    const userCodeIn = String(req.body?.userCode ?? '').trim().toUpperCase();
    if (!userCodeIn) { res.status(400).json({ error: 'userCode required' }); return; }
    const row = ctx.db.prepare(
      'SELECT device_code, expires_at, approved_at FROM device_codes WHERE user_code = ?'
    ).get(userCodeIn) as { device_code: string; expires_at: string; approved_at: string | null } | undefined;
    if (!row) { res.status(404).json({ error: 'unknown user code' }); return; }
    if (new Date(row.expires_at).getTime() < Date.now()) { res.status(410).json({ error: 'code expired' }); return; }
    if (row.approved_at) { res.status(409).json({ error: 'code already approved' }); return; }

    const orgId = req.session!.orgId;
    const token = issueApiKey(ctx.db, orgId, `device:${userCodeIn}`);
    ctx.db.prepare(
      `UPDATE device_codes SET org_id = ?, token_hash = 'issued', approved_at = datetime('now') WHERE device_code = ?`
    ).run(orgId, row.device_code);

    // Park the bearer in-memory keyed by device_code so /poll hands it over
    // exactly once. It's never persisted to disk in plain form.
    if (!(ctx as any)._deviceTokens) (ctx as any)._deviceTokens = new Map<string, string>();
    (ctx as any)._deviceTokens.set(row.device_code, token);

    res.json({ ok: true, orgId });
  });

  // ── Magic-link invite ─────────────────────────────────────────────────────

  router.post('/invite/create', adminGuard, (req: Request, res: Response) => {
    const orgId = req.session!.orgId;
    const nonce = randomBytes(18).toString('base64url');
    const exp = Date.now() + INVITE_TTL_MS;
    const inviteToken = signInviteToken({ orgId, nonce, exp }, ctx.config.secretKey);
    res.json({
      inviteToken,
      joinCommand: `agenfk hub join ${inviteToken}`,
      expiresAt: new Date(exp).toISOString(),
    });
  });

  router.post('/invite/redeem', (req: Request, res: Response) => {
    const inviteToken = String(req.body?.inviteToken ?? '');
    if (!inviteToken) { res.status(400).json({ error: 'inviteToken required' }); return; }
    const parsed = verifyInviteToken(inviteToken, ctx.config.secretKey);
    if (!parsed) { res.status(400).json({ error: 'invalid invite token' }); return; }
    if (parsed.exp < Date.now()) { res.status(400).json({ error: 'invite token expired' }); return; }
    const seen = ctx.db.prepare('SELECT 1 FROM used_invites WHERE nonce = ?').get(parsed.nonce);
    if (seen) { res.status(400).json({ error: 'invite token already used' }); return; }

    const token = issueApiKey(ctx.db, parsed.orgId, 'invite');
    ctx.db.prepare('INSERT INTO used_invites (nonce, org_id) VALUES (?, ?)').run(parsed.nonce, parsed.orgId);
    res.json({ token, orgId: parsed.orgId, hubUrl: publicHubUrl(req) });
  });

  return router;
}
