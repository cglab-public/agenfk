/**
 * boardRoutesOf (CGLAB-702 S7): the routes a signed-in person can reach, found
 * by the hub's own guards wherever they are attached. The admin CLI's parity
 * guard relies on it, so each way of attaching a guard is pinned here.
 */
import { describe, it, expect } from 'vitest';
import express, { Router } from 'express';
import { boardRoutesOf, mountRouter } from '../services/configAuditRoutes';
import { requireAdmin, requireSession } from '../auth/session';

const db = {} as any; // the guards are only attached here, never run
const ok = (_req: any, res: any) => res.json({});

describe('boardRoutesOf', () => {
  it('finds a guard on the route, alone or among other middleware', () => {
    const app = express();
    const r = Router();
    r.get('/a', requireAdmin('s', db), ok);
    r.post('/b', (_q, _s, n) => n(), requireSession('s', db), ok);
    r.get('/open', ok);
    mountRouter(app, '/v1', r);
    expect(boardRoutesOf(app)).toEqual(['GET /v1/a', 'POST /v1/b']);
  });

  it('finds a guard applied with router.use or app.use before the routes', () => {
    const app = express();
    const r = Router();
    r.get('/before', ok);
    r.use(requireAdmin('s', db));
    r.get('/after', ok);
    mountRouter(app, '/x', r);
    app.get('/open', ok);
    app.use(requireSession('s', db));
    app.get('/late', ok);
    expect(boardRoutesOf(app)).toEqual(['GET /late', 'GET /x/after']);
  });

  it('follows a nested router, carrying a guard down into it', () => {
    const app = express();
    const outer = Router();
    const inner = Router();
    inner.delete('/thing/:id', ok);
    outer.use(requireSession('s', db));
    outer.use(inner);
    mountRouter(app, '/v1', outer);
    expect(boardRoutesOf(app)).toEqual(['DELETE /v1/thing/:id']);
  });

  it('a guard inside a mounted router also covers later parent routes that fall through it', () => {
    const app = express();
    const auth = Router();
    auth.use(requireAdmin('s', db));
    mountRouter(app, '/admin', auth);
    app.get('/admin/new', ok);
    expect(boardRoutesOf(app)).toEqual(['GET /admin/new']);
  });

  it('a scoped guard carries into a sibling router mounted at the same path, and out of nested routers', () => {
    const app = express();
    const auth = Router();
    auth.use(requireAdmin('s', db));
    mountRouter(app, '/admin', auth);
    const later = Router();
    later.get('/new', ok);
    mountRouter(app, '/admin', later);
    const elsewhere = Router();
    elsewhere.get('/new', ok);
    mountRouter(app, '/administrator', elsewhere);
    expect(boardRoutesOf(app)).toEqual(['GET /admin/new']);
  });

  it('matches paths without regard to case, as Express does', () => {
    const app = express();
    const auth = Router();
    auth.use(requireAdmin('s', db));
    mountRouter(app, '/admin', auth);
    app.get('/ADMIN/new', ok);
    expect(boardRoutesOf(app)).toEqual(['GET /ADMIN/new']);
  });
});
