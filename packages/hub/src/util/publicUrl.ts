import { Request } from 'express';

/**
 * The origin this request arrived on: the protocol as Express derives it
 * (X-Forwarded-Proto honoured from the hops AGENFK_HUB_TRUST_PROXY trusts - so
 * only as honest as that setting; a directly exposed hub should set it to 0)
 * and the Host header, which proxies preserve.
 *
 * X-Forwarded-Host is NOT read. The production ALB never sets it, so any value
 * the hub sees there was written by the client; trusting it let a caller name
 * the host it "arrived on". A proxy that rewrites Host should be paired with
 * AGENFK_HUB_PUBLIC_URL instead.
 */
export function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') || 'localhost'}`;
}

/**
 * The URL the hub hands to OTHERS - invite join commands, the device-code
 * link, hubUrl, a federation child's parentUrl: AGENFK_HUB_PUBLIC_URL when the
 * operator set one (the canonical name, whichever hostname the admin happened
 * to browse), else the origin this request arrived on.
 */
export function publicHubUrl(req: Request): string {
  const configured = req.app?.locals?.hubPublicUrl as string | undefined;
  return configured || requestOrigin(req);
}
