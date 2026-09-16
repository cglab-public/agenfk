/**
 * The suite-wide network guard (see scripts/vitest-net-guard.mjs).
 *
 * Its two jobs pull against each other: catch anything reaching a real remote,
 * and never trip on loopback — supertest opens an ephemeral 127.0.0.1 socket for
 * every request it makes, so a guard that misjudged loopback would fail
 * thousands of tests rather than the handful that deserve it.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, shared with vitest.setup.ts
import { isLocalHost, connectTarget, installNetGuard } from '../../../../scripts/vitest-net-guard.mjs';

describe('isLocalHost', () => {
  it('allows every loopback spelling a test might use', () => {
    for (const h of [
      'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::',
      '0.0.0.0', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '/tmp/x.sock', '',
    ]) {
      expect(isLocalHost(h), h).toBe(true);
    }
  });

  it('refuses anything that leaves the machine', () => {
    for (const h of [
      'app.posthog.com', 'parent.example.com', 'api.github.com', '8.8.8.8',
      '::ffff:8.8.8.8', '192.168.0.5', '10.0.0.1', '[2606:4700::1111]',
    ]) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });

  it('does not mistake a HOSTNAME that merely starts with 127. for loopback', () => {
    // The check was a string prefix test, not an address test, so any domain
    // beginning "127." — including wildcard-DNS hosts like nip.io that resolve
    // wherever their owner says — was waved straight through. A false negative
    // here is the dangerous direction: the guard reports all-clear while the
    // suite talks to the internet.
    for (const h of ['127.evil.com', '127.0.0.1.nip.io', '127.', '127.0.0.1.example.com']) {
      expect(isLocalHost(h), h).toBe(false);
    }
    // and the real thing still passes, so the fix is not just "block 127"
    for (const h of ['127.0.0.1', '127.1.2.3', '127.255.255.254']) {
      expect(isLocalHost(h), h).toBe(true);
    }
  });

  it('treats a private LAN address as remote, because it still leaves the process', () => {
    // Not an SSRF judgement — a unit test has no business reaching either.
    expect(isLocalHost('192.168.1.1')).toBe(false);
  });
});

describe('connectTarget', () => {
  it('reads the host from every connect() signature', () => {
    expect(connectTarget([{ host: 'app.posthog.com', port: 443 }])).toBe('app.posthog.com');
    expect(connectTarget([443, 'app.posthog.com'])).toBe('app.posthog.com');
    expect(connectTarget([443])).toBe('localhost');
    expect(connectTarget(['/tmp/x.sock'])).toBe('/tmp/x.sock');
    expect(connectTarget([{ path: '/tmp/y.sock' }])).toBe('/tmp/y.sock');
  });
});

describe('the guard as it is actually installed', () => {
  // The predicate above can be perfect while the guard sits unwired in
  // vitest.setup.ts and catches nothing. This asserts it is armed in THIS run.
  it('throws instead of dialling a real remote', async () => {
    const { Socket } = await import('net');
    const s = new Socket();
    expect(() => s.connect(443, 'app.posthog.com')).toThrow(/net-guard/i);
    s.destroy();
  });

  it('names the host, so the culprit is obvious from the failure alone', async () => {
    const { Socket } = await import('net');
    const s = new Socket();
    expect(() => s.connect({ host: 'api.github.com', port: 443 } as any)).toThrow(/api\.github\.com/);
    s.destroy();
  });

  it('lets loopback through, which supertest depends on for every request', async () => {
    const { Socket } = await import('net');
    const s = new Socket();
    // A closed port fails asynchronously; the guard must not reject it here.
    expect(() => s.connect(1, '127.0.0.1')).not.toThrow();
    s.on('error', () => {});
    s.destroy();
  });
});

describe('installNetGuard is idempotent', () => {
  // The repo's normal run is forks+isolate, one process per file, so a second
  // install never happens there. `npm run test:stryker` forces the threads pool
  // (scripts/vitest-shared-config.mjs), where the setup module re-evaluates per
  // file in the SAME worker — each call would wrap the previous wrapper, giving
  // hundreds of nested frames on every supertest connect.
  it('does not stack a second wrapper on top of the first', async () => {
    const { Socket } = await import('net');
    const before = Socket.prototype.connect;
    const uninstall = installNetGuard();
    expect(Socket.prototype.connect).toBe(before);
    uninstall();
    expect(Socket.prototype.connect).toBe(before);
  });
});
