import { createHash } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Response security headers (security audit, AEF-5). Before this the hub sent
 * only `X-Powered-By: Express`: nothing told a browser not to sniff, frame,
 * leak the URL as a referrer, or run injected script.
 *
 * Two policies, chosen by what the response is:
 *
 *  - API_CSP, the default for every response: `default-src 'none'`. A JSON body
 *    or a static asset is never a document that should load anything, so if a
 *    browser is ever tricked into rendering one it loads nothing and cannot be
 *    framed.
 *  - htmlCsp(), set only where the hub sends HTML (the SPA shell, index.html
 *    served as a static file, the maintenance page): the SPA's own origin only,
 *    and its inline scripts allowed BY HASH. The shell has one inline script,
 *    the pre-paint theme bootstrap, and a sha256 source allows exactly that
 *    text, where 'unsafe-inline' would also run anything an XSS injects.
 *    style-src keeps 'unsafe-inline' because React and the charts set inline
 *    style attributes; that is the one deliberate loosening, and styles cannot
 *    execute script.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** 180 days. includeSubDomains, as the audit asked; no `preload`, which is a commitment this hub should not make for its operator. */
const HSTS = 'max-age=15552000; includeSubDomains';

/** CSP source expressions ('sha256-...') for each inline <script> in `html`, in order, duplicates removed. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;   // external: allowed by 'self', and has no text to hash
    // A browser hashes the element's text exactly, whitespace included, but
    // only after the HTML parser has normalised CRLF and lone CR to LF. A file
    // with Windows line endings (a Windows build, `* text=auto`) would hash
    // differently from what the browser computes, and the theme bootstrap would
    // be blocked, so normalise the same way.
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
    "style-src 'self' 'unsafe-inline'",
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
 * Mounted first on every app, so a body-parser error or a 404 carries them too.
 * HSTS follows req.secure, which Express derives from X-Forwarded-Proto only for
 * the hops AGENFK_HUB_TRUST_PROXY trusts: with no proxy trusted a client cannot
 * make the hub claim TLS, and plain HTTP is never told to stay on HTTPS.
 * X-Frame-Options DENY: nothing frames the hub (no iframe in ui, hub-ui or
 * flow-editor; the desktop app loads it as a top-level window).
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
