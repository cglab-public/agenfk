import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Hand a rejected handler to express's error middleware.
 *
 * Under express 4 an `async (req, res) => { ... }` route that threw sent no
 * response at all, so the client hung until its own timeout, the dashboard
 * spun forever, and the error never reached the log (BUG 5d98dd55). The hub
 * now runs express 5, which forwards rejections itself; the wrapper stays so
 * a handler's error path never depends on which express is installed.
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
