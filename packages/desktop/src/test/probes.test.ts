/**
 * CGLAB-167 blocking finding 2: is the thing on that port actually AgEnFK?
 *
 * Adoption is unconditional once a probe succeeds, so a probe that only checks
 * "something answered 200" hands the window to whatever else happens to be on
 * port 3000. A Vite or Next dev server with an SPA catch-all answers 200
 * text/html for ANY path, /version included — so the app would open a
 * chrome-less window on somebody else's application, inject its preload, and
 * cheerfully log that it adopted an AgEnFK server.
 */
import { describe, it, expect } from 'vitest';
import { isAgenfkServer, servesUiBundle, type HttpResponse } from '../main/probes.js';

const respond = (r: HttpResponse | null) => async () => r;

const json = (body: string): HttpResponse =>
  ({ status: 200, contentType: 'application/json; charset=utf-8', body });

describe('isAgenfkServer', () => {
  it('accepts a real AgEnFK /version response', async () => {
    expect(await isAgenfkServer(3000, respond(json('{"version":"1.1.18"}')))).toBe(true);
  });

  it('rejects an SPA catch-all that answers 200 text/html for /version', async () => {
    // A Vite/Next/CRA dev server on 3000 does exactly this.
    const spa: HttpResponse = {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><div id="root"></div>',
    };
    expect(await isAgenfkServer(3000, respond(spa))).toBe(false);
  });

  it('rejects JSON from some other service that has no version field', async () => {
    expect(await isAgenfkServer(3000, respond(json('{"status":"ok","service":"grafana"}')))).toBe(false);
  });

  it('rejects a JSON body that is not an object', async () => {
    expect(await isAgenfkServer(3000, respond(json('"1.1.18"')))).toBe(false);
    expect(await isAgenfkServer(3000, respond(json('[1,2,3]')))).toBe(false);
  });

  it('rejects a malformed body instead of throwing', async () => {
    await expect(isAgenfkServer(3000, respond(json('{not json')))).resolves.toBe(false);
  });

  it('rejects a non-200 status', async () => {
    expect(await isAgenfkServer(3000, respond({ ...json('{"version":"1"}'), status: 404 }))).toBe(false);
  });

  it('rejects when nothing answered at all', async () => {
    expect(await isAgenfkServer(3000, respond(null))).toBe(false);
  });

  it('rejects a version that is not a string', async () => {
    expect(await isAgenfkServer(3000, respond(json('{"version":{"major":1}}')))).toBe(false);
  });

  it('asks the right port and path', async () => {
    let seen: { port: number; path: string } | null = null;
    await isAgenfkServer(3007, async (port, reqPath) => {
      seen = { port, path: reqPath };
      return json('{"version":"1"}');
    });
    expect(seen).toEqual({ port: 3007, path: '/version' });
  });
});

describe('servesUiBundle', () => {
  it('is true when GET / returns the app shell to a browser', async () => {
    const res: HttpResponse = {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><div id="root"></div>',
    };
    expect(await servesUiBundle(3000, respond(res))).toBe(true);
  });

  it('is false for the API-only server that `agenfk up` starts', async () => {
    // That server answers GET / with its JSON banner, whatever the Accept.
    expect(await servesUiBundle(3000, respond(json('{"message":"AgEnFK Framework API is running"}')))).toBe(false);
  });

  it('sends an Accept header asking for HTML, or the server cannot know what we want', async () => {
    let headers: Record<string, string> | undefined;
    await servesUiBundle(3000, async (_p, _path, h) => {
      headers = h;
      return { status: 200, contentType: 'text/html', body: '<html></html>' };
    });
    expect(headers?.Accept).toMatch(/text\/html/);
  });

  it('is false when nothing answered', async () => {
    expect(await servesUiBundle(3000, respond(null))).toBe(false);
  });
});
