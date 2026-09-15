import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Hand a rejected handler to express's error middleware.
 *
 * The hub runs express 4, which does NOT do this for you: an
 * `async (req, res) => { ... }` route that throws sends no response at all, so
 * the client hangs until its own timeout, the dashboard spins forever, and the
 * error never reaches the log. (BUG 5d98dd55; express 5 forwards rejections
 * natively and this wrapper becomes a no-op rather than a hazard.)
 *
 * Wrap every async route handler in it. The alternative — a try/catch in each
 * handler body — is the same thing written twelve times, and a new handler is
 * one forgotten `catch` away from silently hanging again.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  // Never hand express a falsy rejection or a bare string: next(undefined) means
  // "carry on", so the request would fall through to the SPA fallback and answer
  // 200 HTML for an API path, and next('route') / next('router') are routing
  // DIRECTIVES rather than errors. Anything that is not an Error becomes one.
  return (req, res, next) => {
    handler(req, res, next).catch((err: unknown) => {
      next(err instanceof Error ? err : new Error(`handler rejected: ${String(err)}`));
    });
  };
}
