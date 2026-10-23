import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * API_CSP is the default for every response (`default-src 'none'`); htmlCsp() is set
 * only where the hub sends HTML. Inline scripts are allowed by hash, never 'unsafe-inline'.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** 180 days; no `preload`, a commitment the hub should not make for its operator. */
const HSTS = 'max-age=15552000; includeSubDomains';

/** CSP source expressions ('sha256-...') for each inline <script> in `html`, in order, duplicates removed. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;   // external: allowed by 'self', and has no text to hash
    // Browsers hash after normalising CRLF/CR to LF; do the same or CRLF files get blocked.
    const text = m[2].replace(/\r\n?/g, '\n');
    const h = `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
    if (!hashes.includes(h)) hashes.push(h);
  }
  return hashes;
}

/** The policy for an HTML page that runs the given inline scripts (CSP source expressions from inlineScriptHashes). */
export function htmlCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptHashes].join(' ')}`,
    "style-src 'self' 'unsafe-inline'", // deliberate: the UI sets inline style props
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Mounted first so errors and 404s carry the headers. HSTS follows req.secure, which
 * only honours X-Forwarded-Proto from hops AGENFK_HUB_TRUST_PROXY trusts.
 */
export function securityHeaders(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', API_CSP);
    if (req.secure) res.setHeader('Strict-Transport-Security', HSTS);
    next();
  };
}
