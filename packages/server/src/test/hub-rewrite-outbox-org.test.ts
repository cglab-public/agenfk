/**
 * Story: Spoke-side org rename support — local API exposes
 * `POST /internal/hub/rewrite-outbox-org` so `agenfk hub repoint` can rewrite
 * queued outbox payloads in-place when the hub admin renames the org. Without
 * this, the renamed hub rejects every queued event (the orgId baked into each
 * payload no longer matches the API key's org).
 *
 * Source-string assertions matching the convention used by other spoke-side
 * hub tests in this directory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SRC = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

describe('Spoke server: POST /internal/hub/rewrite-outbox-org', () => {
  it('declares the route', () => {
    expect(SRC).toMatch(/['"]\/internal\/hub\/rewrite-outbox-org['"]/);
  });

  it('is gated by the x-agenfk-internal verify token (same as flush/status)', () => {
    const idx = SRC.indexOf('/internal/hub/rewrite-outbox-org');
    expect(idx).toBeGreaterThan(-1);
    const window = SRC.slice(idx, idx + 800);
    expect(window).toMatch(/x-agenfk-internal/);
    expect(window).toMatch(/VERIFY_TOKEN/);
    expect(window).toMatch(/403/);
  });

  it('delegates the rewrite to storage.hubOutboxRewriteOrgId', () => {
    const idx = SRC.indexOf('/internal/hub/rewrite-outbox-org');
    const window = SRC.slice(idx, idx + 800);
    expect(window).toMatch(/hubOutboxRewriteOrgId\s*\(/);
  });

  it('reads { from, to } from the request body and validates them as non-empty strings', () => {
    const idx = SRC.indexOf('/internal/hub/rewrite-outbox-org');
    const window = SRC.slice(idx, idx + 800);
    expect(window).toMatch(/req\.body\??\.from/);
    expect(window).toMatch(/req\.body\??\.to/);
    // 400 on bad input.
    expect(window).toMatch(/400/);
  });
});
