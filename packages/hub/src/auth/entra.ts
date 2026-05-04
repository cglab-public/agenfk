import { Router, Request, Response } from 'express';
import axios from 'axios';
import jwt, { JwtHeader, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { HubServerContext } from '../server.js';
import { decryptSecret } from '../crypto.js';
import { checkEmailAllowlist, completeSsoLogin, issueOAuthState, upsertSsoUser, verifyOAuthState } from './oauth.js';

interface EntraCfg {
  entra_enabled: number;
  entra_tenant_id: string | null;
  entra_client_id: string | null;
  entra_client_secret_enc: string | null;
  email_allowlist: string | null;
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

const discoveryCache = new Map<string, { doc: DiscoveryDoc; jwks: JwksClient; fetchedAt: number }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

async function readEntraConfig(ctx: HubServerContext): Promise<EntraCfg | undefined> {
  return ctx.db.get<EntraCfg>(
    'SELECT entra_enabled, entra_tenant_id, entra_client_id, entra_client_secret_enc, email_allowlist FROM auth_config WHERE org_id = ?',
    [ctx.config.defaultOrgId],
  );
}

async function getDiscovery(tenantId: string) {
  const hit = discoveryCache.get(tenantId);
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`;
  const { data } = await axios.get<DiscoveryDoc>(url, { timeout: 10_000 });
  const jwks = jwksClient({ jwksUri: data.jwks_uri, cache: true, rateLimit: true });
  const entry = { doc: data, jwks, fetchedAt: Date.now() };
  discoveryCache.set(tenantId, entry);
  return entry;
}

function callbackUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.get('host')}/auth/entra/callback`;
}

function verifyIdToken(idToken: string, jwks: JwksClient, audience: string, issuer: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    const getKey = (header: JwtHeader, cb: SigningKeyCallback) => {
      jwks.getSigningKey(header.kid as string, (err, key) => {
        if (err) return cb(err);
        cb(null, key?.getPublicKey());
      });
    };
    jwt.verify(idToken, getKey, { algorithms: ['RS256'], audience, issuer }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded as jwt.JwtPayload);
    });
  });
}

export function entraRouter(ctx: HubServerContext): Router {
  const router = Router();

  router.get('/start', async (req: Request, res: Response) => {
    const cfg = await readEntraConfig(ctx);
    if (!cfg?.entra_enabled || !cfg.entra_tenant_id || !cfg.entra_client_id) {
      return res.status(404).json({ error: 'Entra sign-in is not enabled' });
    }
    let disc;
    try { disc = await getDiscovery(cfg.entra_tenant_id); }
    catch (e: any) { return res.status(502).json({ error: 'Entra discovery failed', detail: e?.message }); }

    const state = issueOAuthState(res);
    const url = new URL(disc.doc.authorization_endpoint);
    url.searchParams.set('client_id', cfg.entra_client_id);
    url.searchParams.set('redirect_uri', callbackUrl(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  router.get('/callback', async (req: Request, res: Response) => {
    const cfg = await readEntraConfig(ctx);
    if (!cfg?.entra_enabled || !cfg.entra_tenant_id || !cfg.entra_client_id || !cfg.entra_client_secret_enc) {
      return res.status(404).json({ error: 'Entra sign-in is not enabled' });
    }
    if (!verifyOAuthState(req, req.query.state as string | undefined)) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });

    let claims: jwt.JwtPayload;
    try {
      const disc = await getDiscovery(cfg.entra_tenant_id);
      const clientSecret = decryptSecret(cfg.entra_client_secret_enc, ctx.config.secretKey);
      const tokenResp = await axios.post(disc.doc.token_endpoint, new URLSearchParams({
        code,
        client_id: cfg.entra_client_id,
        client_secret: clientSecret,
        redirect_uri: callbackUrl(req),
        grant_type: 'authorization_code',
        scope: 'openid profile email',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 });
      const idToken = tokenResp.data.id_token as string | undefined;
      if (!idToken) return res.status(502).json({ error: 'Entra response missing id_token' });
      claims = await verifyIdToken(idToken, disc.jwks, cfg.entra_client_id, disc.doc.issuer);
    } catch (e: any) {
      return res.status(502).json({ error: 'Entra OAuth exchange failed', detail: e?.message });
    }

    const subject = (claims.oid as string | undefined) || (claims.sub as string | undefined);
    const email = (claims.email as string | undefined) || (claims.preferred_username as string | undefined);
    if (!subject || !email) return res.status(403).json({ error: 'Entra ID token missing sub/email' });

    const allow = checkEmailAllowlist(email, cfg.email_allowlist);
    if (!allow.allowed) return res.status(403).json({ error: allow.reason });

    const user = await upsertSsoUser(ctx.db, ctx.config.defaultOrgId, { provider: 'entra', subject, email });
    if (!user.active) return res.status(403).json({ error: 'Account is deactivated' });
    await completeSsoLogin(ctx.db, res, user, ctx.config.sessionSecret);
    res.redirect('/');
  });

  return router;
}

// Test-only escape hatch — clears discovery cache between tests.
export function _resetEntraDiscoveryCache(): void { discoveryCache.clear(); }
