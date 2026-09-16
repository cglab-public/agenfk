import { Request } from 'express';

/** The URL clients should use to reach this hub, honouring reverse-proxy headers. */
export function publicHubUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim()
    || (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim()
    || req.headers.host
    || 'localhost';
  return `${proto}://${host}`;
}
