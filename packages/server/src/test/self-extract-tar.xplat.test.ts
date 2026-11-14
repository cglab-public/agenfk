/**
 * @file GitHub #208 — the hub's self-extract runs tar the way the tar wants.
 *
 * defaultSelfExtract ran `tar -xzf "C:\..." -C "C:\..."` and `tar -tzf "C:\..."`
 * on every OS. GNU tar (Git Bash's) reads `C:` as a remote host - "Cannot
 * connect to C: resolve failed" - so a server started from Git Bash could
 * never recover itself. It now takes the rule from the install root's
 * bin/tar-flags.mjs, loaded the way the prune already loads
 * bin/sync-install-dir.mjs: GNU tar on Windows gets --force-local and C:/
 * paths, bsdtar native paths and no flag, POSIX the commands it always had.
 * An install root without the module (one older than the rule) gets the
 * commands as they were.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selfExtractTarCommands, loadTarRule } from '../hub/upgradeSync';
import * as rule from '../../../../bin/tar-flags.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('loadTarRule', () => {
  // The fallback below is for a root that really lacks the module; a typo'd
  // path or a renamed export must not reach it silently.
  it('loads the rule from an install root that ships bin/tar-flags.mjs', async () => {
    const loaded = await loadTarRule(REPO_ROOT);
    expect(loaded).not.toBeNull();
    expect(typeof loaded!.needsForceLocal).toBe('function');
    expect(typeof loaded!.tarPathFor).toBe('function');
    expect(typeof loaded!.tarVersionText).toBe('function');
    expect(loaded!.needsForceLocal('win32', 'tar (GNU tar) 1.35')).toBe(true);
    expect(loaded!.tarPathFor('C:\\a\\b', 'win32', 'tar (GNU tar) 1.35')).toBe('C:/a/b');
  });

  it('is null for an install root without it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-no-tar-rule-'));
    try {
      expect(await loadTarRule(root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

const GNU = 'tar (GNU tar) 1.35\n';
const BSD = 'bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley\n';
const TMP = 'C:\\Users\\u\\AppData\\Local\\Temp\\agenfk-self-heal-1.tar.gz';
const ROOT = 'C:\\Users\\u\\.agenfk-system';

describe('selfExtractTarCommands', () => {
  it('GNU tar on Windows: --force-local and C:/ paths, for the extract and the listing', () => {
    expect(selfExtractTarCommands(rule, 'win32', GNU, TMP, ROOT)).toEqual({
      extract: 'tar --force-local -xzf "C:/Users/u/AppData/Local/Temp/agenfk-self-heal-1.tar.gz" -C "C:/Users/u/.agenfk-system"',
      list: 'tar --force-local -tzf "C:/Users/u/AppData/Local/Temp/agenfk-self-heal-1.tar.gz"',
    });
  });

  it('bsdtar on Windows: native paths and no flag (it rejects --force-local)', () => {
    expect(selfExtractTarCommands(rule, 'win32', BSD, TMP, ROOT)).toEqual({
      extract: `tar -xzf "${TMP}" -C "${ROOT}"`,
      list: `tar -tzf "${TMP}"`,
    });
  });

  it('off Windows: exactly the commands it always ran', () => {
    expect(selfExtractTarCommands(rule, 'linux', GNU, '/tmp/agenfk-self-heal-1.tar.gz', '/opt/agenfk')).toEqual({
      extract: 'tar -xzf "/tmp/agenfk-self-heal-1.tar.gz" -C "/opt/agenfk"',
      list: 'tar -tzf "/tmp/agenfk-self-heal-1.tar.gz"',
    });
  });

  it('an install root without bin/tar-flags.mjs: the commands as they were', () => {
    expect(selfExtractTarCommands(null, 'win32', GNU, TMP, ROOT)).toEqual({
      extract: `tar -xzf "${TMP}" -C "${ROOT}"`,
      list: `tar -tzf "${TMP}"`,
    });
  });
});
