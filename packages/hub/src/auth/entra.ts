import { Router, Request, Response } from 'express';
import { requestOrigin } from '../util/publicUrl.js';
import axios from 'axios';
import jwt, { JwtHeader, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { HubServerContext } from '../server.js';
import { decryptSecret } from '../crypto.js';
import { checkEmailAllowlist, completeSsoLogin, findInvitedSsoUser, issueOAuthState, ssoRefusal, verifyOAuthState } from './oauth.js';
import { rateLimit } from '../util/rateLimit.js';
import { asyncRoute } from '../util/asyncRoute.js';

/** A Directory (tenant) ID as Entra shows it. */
export const ENTRA_TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The multi-tenant aliases. Their discovery document names the issuer as the
 * `{tenantid}` template, so a token never verifies against it, and nothing
 * would say which tenant a sign-in belongs to. Multi-tenant sign-in arrives
 * with the join policy (a list of allowed tenant ids), not through these.
 */
const ENTRA_TENANT_ALIASES = new Set(['organizations', 'common', 'consumers']);
export const isEntraTenantAlias = (tenant: string): boolean => ENTRA_TENANT_ALIASES.has(tenant.trim().toLowerCase());
export const ENTRA_ALIAS_REFUSAL = 'Microsoft Entra sign-in needs the Directory (tenant) ID of one tenant, or one of its verified domains. '
  + 'The organizations, common and consumers aliases are not supported; signing in several tenants will come with the join policy.';

/**
 * The tenant a discovery document's issuer names: the GUID for a tenant
 * configured by id or by verified domain, the literal {tenantid} template for
 * the aliases (null then, since it names no tenant).
 */
export function issuerTenant(issuer: string): string | null {
  const m = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(issuer);
  if (!m || m[1].includes('{') || isEntraTenantAlias(m[1])) return null;
  return m[1].toLowerCase();
}

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

// The host the user is browsing, never AGENFK_HUB_PUBLIC_URL: the state cookie
// was set on this host, so the provider must send the user back to it. The
// protocol honours X-Forwarded-Proto only from a trusted proxy.
function callbackUrl(req: Request): string {
  return `${requestOrigin(req)}/auth/entra/callback`;
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

  // Unauthenticated entry point, so it is the front door: bound it before a
  // caller can drive config reads and redirects in a loop.
  router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: 'Too many sign-in requests, slow down.' }));

  router.get('/start', asyncRoute(async (req: Request, res: Response) => {
    const cfg = await readEntraConfig(ctx);
    if (!cfg?.entra_enabled || !cfg.entra_tenant_id || !cfg.entra_client_id) {
      return res.status(404).json({ error: 'Entra sign-in is not enabled' });
    }
    // The callback refuses this tenant, so do not send anyone to Microsoft first.
    if (isEntraTenantAlias(cfg.entra_tenant_id)) {
      return res.status(403).json({ error: ENTRA_ALIAS_REFUSAL });
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
  }));

  router.get('/callback', asyncRoute(async (req: Request, res: Response) => {
    const cfg = await readEntraConfig(ctx);
    if (!cfg?.entra_enabled || !cfg.entra_tenant_id || !cfg.entra_client_id || !cfg.entra_client_secret_enc) {
      return res.status(404).json({ error: 'Entra sign-in is not enabled' });
    }
    if (!verifyOAuthState(req, req.query.state as string | undefined)) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });
    // A row saved before the admin route refused these: the hub cannot tell
    // which tenant such a sign-in should belong to, so it signs nobody in.
    if (isEntraTenantAlias(cfg.entra_tenant_id)) {
      return res.status(403).json({ error: ENTRA_ALIAS_REFUSAL });
    }

    let claims: jwt.JwtPayload;
    let expectedTenant: string | null;
    try {
      const disc = await getDiscovery(cfg.entra_tenant_id);
      expectedTenant = issuerTenant(disc.doc.issuer);
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
    // `name` comes free with the `profile` scope we already request. It is
    // optional: a tenant can withhold it, and sign-in must still succeed.
    const name = (claims.name as string | undefined)
      || [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim()
      || undefined;
    if (!subject || !email) return res.status(403).json({ error: 'Entra ID token missing sub/email' });
    // The issuer check pins the tenant only as far as the discovery document
    // does; tid is the claim Microsoft documents for "which tenant is this".
    // It is compared with the tenant the issuer names, which covers a tenant
    // stored as a verified domain as well as one stored by id.
    const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : null;
    if (!expectedTenant) return res.status(403).json({ error: ENTRA_ALIAS_REFUSAL });
    if (!tid || tid !== expectedTenant) {
      return res.status(403).json({ error: 'This Microsoft account belongs to a different tenant than the one this hub signs in' });
    }

    const allow = checkEmailAllowlist(email, cfg.email_allowlist);
    if (!allow.allowed) return res.status(403).json({ error: allow.reason });

    const found = await findInvitedSsoUser(ctx.db, ctx.config.defaultOrgId, { provider: 'entra', subject, email, name }, req.ip ?? null);
    if (!('user' in found)) return res.status(403).json({ error: ssoRefusal(found) });
    const { user } = found;
    if (!user.active) return res.status(403).json({ error: 'Account is deactivated' });
    await completeSsoLogin(ctx.db, res, user, ctx.config.sessionSecret);
    res.redirect('/');
  }));

  return router;
}

// Test-only escape hatch — clears discovery cache between tests.
export function _resetEntraDiscoveryCache(): void { discoveryCache.clear(); }
