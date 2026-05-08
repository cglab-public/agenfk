/**
 * Story 7 — flusher attaches `x-agenfk-version` header on every batch POST so
 * the hub can record the running version per installation.
 *
 * Source-string regression matching the existing convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const FLUSHER_SRC = readFileSync(
  path.resolve(__dirname, '../hub/flusher.ts'),
  'utf8'
);

describe('Story 7 — flusher attaches x-agenfk-version header', () => {
  it('axios default headers include X-Agenfk-Version', () => {
    expect(FLUSHER_SRC).toMatch(/['"]X-Agenfk-Version['"]\s*:/i);
  });

  it('the version is read from the package CURRENT_VERSION rather than hardcoded', () => {
    // Either an import from the cli package's package.json, a require() of
    // the local package.json, or accepts an explicit constructor param.
    expect(FLUSHER_SRC).toMatch(/CURRENT_VERSION|agenfkVersion|getAgenfkVersion|package\.json/);
  });
});
