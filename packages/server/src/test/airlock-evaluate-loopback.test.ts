/**
 * POST /airlock/evaluate answers this machine only (GH-294, review finding 5).
 *
 * The handler is driven directly with a fake request, so the caller's address
 * can be anything: a supertest call always arrives from loopback.
 */
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_AIRLOCK_POLICY, normalizeAirlockPolicy } from '@agenfk/core';
import { registerAirlockRoutes } from '../airlock/routes';

function harness() {
  const handlers: Record<string, (req: any, res: any, next: any) => Promise<void>> = {};
  const app = {
    get: (p: string, ...h: any[]) => { handlers[`GET ${p}`] = h.at(-1); },
    put: (p: string, ...h: any[]) => { handlers[`PUT ${p}`] = h.at(-1); },
    post: (p: string, ...h: any[]) => { handlers[`POST ${p}`] = h.at(-1); },
    use: () => {},
  };
  const recordAirlockDecision = vi.fn(async () => {});
  const recordHubEvent = vi.fn();
  const enforce = { scope: 'local', revision: 1, policy: normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'enforce' }), updatedAt: '', updatedBy: '', authority: 'local' };
  const storage: any = {
    getAirlockPolicy: async (scope: string) => (scope === 'local' ? enforce : null),
    recordAirlockDecision,
  };
  registerAirlockRoutes(app, {
    storage: () => storage,
    hubJoined: () => false,
    recordHubEvent,
    emit: () => {},
    activeWork: () => null,
  });
  const call = async (remoteAddress: string) => {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    const next = vi.fn();
    await handlers['POST /airlock/evaluate']({
      socket: { remoteAddress },
      body: { client: 'pi', model: 'p/m', toolName: 'bash', args: { command: 'curl http://169.254.169.254/' } },
    }, res, next);
    expect(next).not.toHaveBeenCalled();
    return res;
  };
  return { call, recordAirlockDecision, recordHubEvent };
}

describe('evaluate loopback guard', () => {
  for (const addr of ['192.168.1.20', '10.0.0.5', '2001:db8::1', 'fe80::1', '::ffff:192.168.1.20']) {
    it(`refuses ${addr} with 403 and writes nothing`, async () => {
      const h = harness();
      const res = await h.call(addr);
      expect(res.statusCode).toBe(403);
      expect(h.recordAirlockDecision).not.toHaveBeenCalled();
      expect(h.recordHubEvent).not.toHaveBeenCalled();
    });
  }

  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    it(`answers ${addr}`, async () => {
      const h = harness();
      const res = await h.call(addr);
      expect(res.statusCode).toBe(200);
      expect(res.body.verdict.decision).toBe('deny');
      expect(h.recordAirlockDecision).toHaveBeenCalledTimes(1);
    });
  }
});
