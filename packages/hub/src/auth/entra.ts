import { Router, Request, Response } from 'express';
import { requestOrigin } from '../util/publicUrl.js';
import axios from 'axios';
import jwt, { JwtHeader, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { HubServerContext } from '../server.js';
import { decryptSecret } from '../crypto.js';
import { checkEmailAllowlist, completeSsoLogin, findInvitedSsoUser, issueOAuthState, verifyOAuthState } from './oauth.js';
import { rateLimit } from '../util/rateLimit.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { CLIENT_ASSERTION_TYPE, StsAssertionError, describeEntraFailure, entraAssertionEnabled, getStsClientAssertion, EntraFailure, recordEntraExchange } from './entraAssertion.js';

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
    let disc;
    try { disc = await getDiscovery(cfg.entra_tenant_id); }
    catch (e: any) {
      // The axios text stays in the log; an unauthenticated caller gets a fixed phrase.
      console.error(`[HUB] Entra discovery failed: ${e?.message ?? e}`);
      return res.status(502).json({ error: 'Entra discovery failed', detail: 'Entra discovery unavailable' });
    }

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
    if (!cfg?.entra_enabled || !cfg.entra_tenant_id || !cfg.entra_client_id
      || (!cfg.entra_client_secret_enc && !entraAssertionEnabled())) {
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
      const redirectUri = callbackUrl(req);
      const exchange = (credential: Record<string, string>) => axios.post(disc.doc.token_endpoint, new URLSearchParams({
        code,
        client_id: cfg.entra_client_id!,
        ...credential,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'openid profile email',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 });
      const secretCredential = () => ({ client_secret: decryptSecret(cfg.entra_client_secret_enc!, ctx.config.secretKey) });

      let tokenResp;
      if (!entraAssertionEnabled()) {
        tokenResp = await exchange(secretCredential());
        recordEntraExchange('secret');
      } else {
        // Federated credential first; the stored secret is the one retry, only
        // when the assertion could not be minted or Entra refused it as a client.
        let assertionFailure: EntraFailure | undefined;
        let clientAssertion: string | undefined;
        try {
          clientAssertion = await getStsClientAssertion();
        } catch (e: any) {
          if (!cfg.entra_client_secret_enc) throw e;
          assertionFailure = { entraError: 'sts', detail: `STS: ${describeEntraFailure(e).detail}` };
        }
        if (clientAssertion) {
          try {
            tokenResp = await exchange({ client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: clientAssertion });
            recordEntraExchange('assertion');
            console.log('[HUB] Entra code exchange succeeded with the AWS STS client assertion.');
          } catch (e: any) {
            const failure = describeEntraFailure(e);
            if (failure.entraError !== 'invalid_client' || !cfg.entra_client_secret_enc) throw e;
            assertionFailure = failure;
          }
        }
        if (assertionFailure) {
          console.warn(`[HUB] Entra client assertion path failed (${assertionFailure.detail}); retrying once with the client secret.`);
          tokenResp = await exchange(secretCredential());
          recordEntraExchange('secret-fallback', assertionFailure.entraError ?? 'unknown');
          console.log('[HUB] Entra code exchange succeeded with the client secret (assertion path failed).');
        }
      }
      const idToken = tokenResp!.data.id_token as string | undefined;
      if (!idToken) return res.status(502).json({ error: 'Entra response missing id_token' });
      claims = await verifyIdToken(idToken, disc.jwks, cfg.entra_client_id, disc.doc.issuer);
    } catch (e: any) {
      // Full text stays in the log; the caller is unauthenticated and gets
      // codes only (Entra's description has Trace/Correlation IDs, STS's has the role ARN).
      const failure = describeEntraFailure(e);
      const fromSts = e instanceof StsAssertionError;
      console.error(`[HUB] Entra OAuth exchange failed${fromSts ? ' (STS)' : ''}: ${failure.detail}`
        + (failure.errorCodes?.length ? ` (error_codes: ${failure.errorCodes.join(',')})` : ''));
      return res.status(502).json({
        error: 'Entra OAuth exchange failed',
        detail: fromSts ? 'STS unavailable' : failure.entraError ? 'Entra rejected the token request' : 'Entra sign-in failed',
        ...(failure.entraError ? { entra_error: failure.entraError } : {}),
        ...(failure.errorCodes?.length ? { error_codes: failure.errorCodes } : {}),
      });
    }

    const subject = (claims.oid as string | undefined) || (claims.sub as string | undefined);
    const email = (claims.email as string | undefined) || (claims.preferred_username as string | undefined);
    // `name` comes free with the `profile` scope we already request. It is
    // optional: a tenant can withhold it, and sign-in must still succeed.
    const name = (claims.name as string | undefined)
      || [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim()
      || undefined;
    if (!subject || !email) return res.status(403).json({ error: 'Entra ID token missing sub/email' });

    const allow = checkEmailAllowlist(email, cfg.email_allowlist);
    if (!allow.allowed) return res.status(403).json({ error: allow.reason });

    const user = await findInvitedSsoUser(ctx.db, ctx.config.defaultOrgId, { provider: 'entra', subject, email, name });
    if (!user) return res.status(403).json({ error: 'Account not invited — ask your admin to invite you first' });
    if (!user.active) return res.status(403).json({ error: 'Account is deactivated' });
    await completeSsoLogin(ctx.db, res, user, ctx.config.sessionSecret);
    res.redirect('/');
  }));

  return router;
}

// Test-only escape hatch — clears discovery cache between tests.
export function _resetEntraDiscoveryCache(): void { discoveryCache.clear(); }
