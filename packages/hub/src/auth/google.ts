import { Router, Request, Response } from 'express';
import axios from 'axios';
import { HubServerContext } from '../server.js';
import { decryptSecret } from '../crypto.js';
import { checkEmailAllowlist, completeSsoLogin, issueOAuthState, upsertSsoUser, verifyOAuthState } from './oauth.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

interface GoogleCfg { google_enabled: number; google_client_id: string | null; google_client_secret_enc: string | null; email_allowlist: string | null }

function readGoogleConfig(ctx: HubServerContext) {
  return ctx.db.prepare(
    'SELECT google_enabled, google_client_id, google_client_secret_enc, email_allowlist FROM auth_config WHERE org_id = ?'
  ).get(ctx.config.defaultOrgId) as unknown as GoogleCfg | undefined;
}

function callbackUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.get('host')}/auth/google/callback`;
}

export function googleRouter(ctx: HubServerContext): Router {
  const router = Router();

  router.get('/start', (req: Request, res: Response) => {
    const cfg = readGoogleConfig(ctx);
    if (!cfg?.google_enabled || !cfg.google_client_id) {
      return res.status(404).json({ error: 'Google sign-in is not enabled' });
    }
    const state = issueOAuthState(res);
    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('client_id', cfg.google_client_id);
    url.searchParams.set('redirect_uri', callbackUrl(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  router.get('/callback', async (req: Request, res: Response) => {
    const cfg = readGoogleConfig(ctx);
    if (!cfg?.google_enabled || !cfg.google_client_id || !cfg.google_client_secret_enc) {
      return res.status(404).json({ error: 'Google sign-in is not enabled' });
    }
    if (!verifyOAuthState(req, req.query.state as string | undefined)) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });

    let userinfo: { sub: string; email: string; email_verified?: boolean };
    try {
      const clientSecret = decryptSecret(cfg.google_client_secret_enc, ctx.config.secretKey);
      const tokenResp = await axios.post(GOOGLE_TOKEN, new URLSearchParams({
        code,
        client_id: cfg.google_client_id,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(req),
        grant_type: 'authorization_code',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 });
      const accessToken = tokenResp.data.access_token;
      const userResp = await axios.get(GOOGLE_USERINFO, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000,
      });
      userinfo = userResp.data;
    } catch (e: any) {
      return res.status(502).json({ error: 'Google OAuth exchange failed', detail: e?.message });
    }
    if (!userinfo.email || userinfo.email_verified === false) {
      return res.status(403).json({ error: 'Google account email is not verified' });
    }

    const allow = checkEmailAllowlist(userinfo.email, cfg.email_allowlist);
    if (!allow.allowed) return res.status(403).json({ error: allow.reason });

    const user = upsertSsoUser(ctx.db, ctx.config.defaultOrgId, { provider: 'google', subject: userinfo.sub, email: userinfo.email });
    if (!user.active) return res.status(403).json({ error: 'Account is deactivated' });
    completeSsoLogin(ctx.db, res, user, ctx.config.sessionSecret);
    res.redirect('/');
  });

  return router;
}
