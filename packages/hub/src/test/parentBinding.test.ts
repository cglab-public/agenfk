// The child hub's record of its parent (CGLAB-181, task 3).
//
// The binding holds a bearer token, so it is encrypted at rest with the hub's
// own secret key rather than written into system_state in the clear.
import { describe, it, expect } from 'vitest';
import { openDb } from '../db';
import {
  readParentBinding, writeParentBinding, clearParentBinding, markBindingRevoked,
  PARENT_BINDING_KEY, assertHttpUrl,
} from '../services/federation/parentBinding';

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const binding = {
  parentUrl: 'https://parent.example.com',
  token: 'fed_' + 'f'.repeat(64),
  childHubId: 'ch-1',
};

describe('parentBinding', () => {
  it('round-trips through system_state', async () => {
    const db = await openDb(':memory:');
    expect(await readParentBinding(db, SECRET)).toBeNull();
    await writeParentBinding(db, SECRET, binding);
    const got = await readParentBinding(db, SECRET);
    expect(got).toMatchObject({ ...binding, state: 'active' });
    expect(typeof got!.enrolledAt).toBe('string');
    await db.close();
  });

  it('never stores the token in the clear', async () => {
    const db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    const row = await db.get<{ value: string }>('SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
    expect(row.value).not.toContain(binding.token);
    expect(row.value).not.toContain('fed_');
    // the URL is not a secret and stays readable for operators
    expect(row.value).toContain('parent.example.com');
    await db.close();
  });

  it('refuses to decrypt with the wrong secret rather than returning a broken binding', async () => {
    const db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    await expect(readParentBinding(db, OTHER)).rejects.toThrow();
    await db.close();
  });

  it('replaces an existing binding instead of accumulating rows', async () => {
    const db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    await writeParentBinding(db, SECRET, { ...binding, parentUrl: 'https://other.example.com', childHubId: 'ch-2' });
    const rows = await db.all('SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY]);
    expect(rows).toHaveLength(1);
    expect((await readParentBinding(db, SECRET))!.childHubId).toBe('ch-2');
    await db.close();
  });

  it('marks a binding revoked without destroying it, so the UI can explain why sync stopped', async () => {
    const db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    await markBindingRevoked(db, SECRET);
    const got = await readParentBinding(db, SECRET);
    expect(got).toMatchObject({ state: 'revoked', parentUrl: binding.parentUrl, childHubId: 'ch-1' });
    await db.close();
  });

  it('clearing removes the row entirely', async () => {
    const db = await openDb(':memory:');
    await writeParentBinding(db, SECRET, binding);
    await clearParentBinding(db);
    expect(await readParentBinding(db, SECRET)).toBeNull();
    expect(await db.get('SELECT value FROM system_state WHERE key = ?', [PARENT_BINDING_KEY])).toBeFalsy();
    await db.close();
  });

  it('treats a corrupt row as no binding rather than crashing the worker', async () => {
    const db = await openDb(':memory:');
    await db.run('INSERT INTO system_state (key, value) VALUES (?, ?)', [PARENT_BINDING_KEY, 'not json']);
    expect(await readParentBinding(db, SECRET)).toBeNull();
    await db.close();
  });

  it('rejects a parent URL that is not http(s)', async () => {
    const db = await openDb(':memory:');
    await expect(writeParentBinding(db, SECRET, { ...binding, parentUrl: 'javascript:alert(1)' })).rejects.toThrow(/http/i);
    await expect(writeParentBinding(db, SECRET, { ...binding, parentUrl: 'file:///etc/passwd' })).rejects.toThrow(/http/i);
    expect(await readParentBinding(db, SECRET)).toBeNull();
    await db.close();
  });
});

describe('assertHttpUrl', () => {
  it('normalises the stored URL so requests do not end up with a double slash', () => {
    // The worker builds `${parentUrl}/v1/federation/ping`, so a trailing slash
    // would produce //v1/federation/ping.
    expect(assertHttpUrl('https://parent.example.com/')).toBe('https://parent.example.com');
    expect(assertHttpUrl('https://parent.example.com')).toBe('https://parent.example.com');
    expect(assertHttpUrl('https://parent.example.com/hub/')).toBe('https://parent.example.com/hub');
    expect(assertHttpUrl('https://parent.example.com:8443/')).toBe('https://parent.example.com:8443');
  });

  it('drops a query string and fragment rather than carrying them into every call', () => {
    expect(assertHttpUrl('https://parent.example.com/?x=1#frag')).toBe('https://parent.example.com');
  });

  it('accepts http as well as https, for a LAN parent', () => {
    expect(assertHttpUrl('http://hub.internal:4000')).toBe('http://hub.internal:4000');
  });

  it('refuses anything that is not http(s), and anything unparseable', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'data:text/html,x']) {
      expect(() => assertHttpUrl(bad)).toThrow(/http/i);
    }
    expect(() => assertHttpUrl('not a url')).toThrow(/valid/i);
    expect(() => assertHttpUrl('')).toThrow(/valid/i);
  });
});
