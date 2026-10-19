/**
 * Story 76da75ea (INFRA-463), review round 1: when the server rewrites
 * ~/.agenfk/hub.json (an admin repoint campaign), it keeps the `source` the
 * CLI recorded, so `agenfk hub status` still says where the URL came from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

import { writeHubConfigFile, hubConfigPath } from '../hub/hubClient';

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-hubcfg-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const read = () => JSON.parse(fs.readFileSync(hubConfigPath(), 'utf8'));

describe('writeHubConfigFile', () => {
  it('keeps the source recorded in the file it replaces', () => {
    fs.mkdirSync(path.dirname(hubConfigPath()), { recursive: true });
    fs.writeFileSync(hubConfigPath(), JSON.stringify({ url: 'https://old.acme.com', token: 't', orgId: 'o', source: 'dns' }));
    writeHubConfigFile({ url: 'https://new.acme.com', token: 't2', orgId: 'o' });
    expect(read()).toEqual({ url: 'https://new.acme.com', token: 't2', orgId: 'o', source: 'dns' });
  });

  it('writes no source when there was no file, or the file had none', () => {
    writeHubConfigFile({ url: 'https://new.acme.com', token: 't', orgId: 'o' });
    expect(read()).not.toHaveProperty('source');
  });

  it('ignores an unreadable previous file instead of failing the write', () => {
    fs.mkdirSync(path.dirname(hubConfigPath()), { recursive: true });
    fs.writeFileSync(hubConfigPath(), '{not json');
    writeHubConfigFile({ url: 'https://new.acme.com', token: 't', orgId: 'o' });
    expect(read()).toEqual({ url: 'https://new.acme.com', token: 't', orgId: 'o' });
  });

  it('writes the file private to the user (0600)', () => {
    writeHubConfigFile({ url: 'https://new.acme.com', token: 't', orgId: 'o' });
    if (process.platform !== 'win32') expect(fs.statSync(hubConfigPath()).mode & 0o777).toBe(0o600);
  });
});
