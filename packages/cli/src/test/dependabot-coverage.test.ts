/**
 * Dependabot covers a PUBLIC repo that ships an installer onto other people's
 * machines, so an unwatched dependency ecosystem is a real exposure rather than
 * housekeeping. These tests parse the real config artifact and check it against
 * what the repo actually contains, so adding a new Dockerfile or a new workspace
 * package that Dependabot does not watch fails the suite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';

const repoRoot = join(__dirname, '../../../..');
const configPath = join(repoRoot, '.github/dependabot.yml');

type Update = {
  'package-ecosystem': string;
  directory?: string;
  directories?: string[];
  schedule?: { interval?: string };
  groups?: Record<string, unknown>;
  ignore?: Array<{ 'dependency-name'?: string }>;
  'open-pull-requests-limit'?: number;
};

const readConfig = () => load(readFileSync(configPath, 'utf8')) as { version?: number; updates?: Update[] };
const ecosystems = () => new Set((readConfig().updates ?? []).map(u => u['package-ecosystem']));

describe('Dependabot config (CGLAB-84)', () => {
  it('exists', () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it('is valid YAML declaring version 2', () => {
    const cfg = readConfig();
    expect(cfg.version).toBe(2);
    expect(Array.isArray(cfg.updates)).toBe(true);
    expect(cfg.updates!.length).toBeGreaterThan(0);
  });

  it('every update entry names an ecosystem, a directory and a schedule', () => {
    for (const u of readConfig().updates!) {
      expect(u['package-ecosystem'], JSON.stringify(u)).toBeTruthy();
      expect(u.directory ?? u.directories, JSON.stringify(u)).toBeTruthy();
      expect(u.schedule?.interval, JSON.stringify(u)).toBeTruthy();
    }
  });

  it('watches npm, because the repo has package.json manifests', () => {
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true);
    expect(ecosystems()).toContain('npm');
  });

  it('watches github-actions, and the repo does have workflows', () => {
    const workflows = readdirSync(join(repoRoot, '.github/workflows')).filter(f => f.endsWith('.yml'));
    expect(workflows.length).toBeGreaterThan(0);
    expect(ecosystems()).toContain('github-actions');
  });

  it('watches docker, because the repo ships a Dockerfile', () => {
    expect(existsSync(join(repoRoot, 'packages/hub/Dockerfile'))).toBe(true);
    expect(ecosystems()).toContain('docker');
  });

  it('declares exactly ONE npm entry — workspaces share a single root lockfile', () => {
    // Per-package entries would emit concurrent PRs all rewriting the same
    // package-lock.json, which conflict by construction.
    const npmEntries = readConfig().updates!.filter(u => u['package-ecosystem'] === 'npm');
    expect(npmEntries).toHaveLength(1);
    expect(npmEntries[0].directory).toBe('/');
  });

  it('ignores @agenfk/* so Dependabot cannot fight scripts/bump-version.mjs', () => {
    // The internal packages are exact-pinned to the monorepo version and are not
    // published to npm; bump-version.mjs rewrites them in lockstep.
    const npmEntry = readConfig().updates!.find(u => u['package-ecosystem'] === 'npm')!;
    const ignored = (npmEntry.ignore ?? []).map(i => i['dependency-name']);
    expect(ignored).toContain('@agenfk/*');
  });

  it('groups updates so the PR board is not buried', () => {
    for (const u of readConfig().updates!) {
      expect(Object.keys(u.groups ?? {}).length, `${u['package-ecosystem']} has no groups`).toBeGreaterThan(0);
    }
  });
});
