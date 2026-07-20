/**
 * The flusher attaches an `X-Agenfk-Version` header on every batch POST so the
 * hub can record the running version per installation.
 *
 * Behaviour-based: construct a real Flusher (with its default HTTP client) and
 * assert the actual axios instance that will send batches carries the header,
 * set to the real package version — not a grep of flusher.ts source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { SQLiteStorageProvider } from '@agenfk/storage-sqlite';
import { Flusher } from '../hub/flusher';

const ROOT = path.resolve(__dirname, '../../../..');
const PKG_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version as string;

describe('flusher attaches X-Agenfk-Version', () => {
  it('the batch HTTP client carries the X-Agenfk-Version header set to the package version', async () => {
    const storage = new SQLiteStorageProvider();
    await storage.init({ path: ':memory:' });
    // No injected httpClient → the Flusher builds its default axios instance,
    // which is what actually ships batches to the hub.
    const flusher = new Flusher(storage, { url: 'http://hub.test', token: 't', orgId: 'o' }, 'inst');

    const headers = (flusher as any).http.defaults.headers as Record<string, unknown>;
    const version = headers['X-Agenfk-Version'];

    expect(version).toBe(PKG_VERSION); // read from package.json, not hardcoded
    expect(String(version)).toMatch(/^\d+\.\d+\.\d+/); // real semver, non-empty
  });
});
