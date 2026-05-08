/**
 * Story 4 — AdminUpgrades hub-ui page (regression-style source assertions
 * matching the existing convention in this repo, since hub-ui has no DOM
 * test infra and we want the assertion to live where @types/node is wired).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const PAGE_PATH = path.resolve(__dirname, '../../../hub-ui/src/pages/AdminUpgrades.tsx');
const ADMIN_PATH = path.resolve(__dirname, '../../../hub-ui/src/pages/Admin.tsx');
const APP_PATH = path.resolve(__dirname, '../../../hub-ui/src/App.tsx');

describe('Story 4 — AdminUpgrades page', () => {
  it('AdminUpgrades.tsx exists', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('exports an AdminUpgrades React component', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/export\s+function\s+AdminUpgrades\b|export\s+const\s+AdminUpgrades\b/);
  });

  it('declares an issue form that posts to /v1/admin/upgrade', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/api\.post\(\s*['"]\/v1\/admin\/upgrade['"]/);
    expect(src).toMatch(/targetVersion/);
    expect(src).toMatch(/scope/);
  });

  it('lists existing directives by GETting /v1/admin/upgrade', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/api\.get\(\s*['"]\/v1\/admin\/upgrade['"]/);
  });

  it('renders the per-installation agenfkVersion in the breakdown', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/agenfkVersion/);
  });

  it('exposes aggregate progress counts (pending / in_progress / succeeded / failed)', () => {
    const src = readFileSync(PAGE_PATH, 'utf8');
    expect(src).toMatch(/progress/);
    expect(src).toMatch(/succeeded/);
    expect(src).toMatch(/failed/);
  });

  it('Admin.tsx nav links to the upgrades route', () => {
    const src = readFileSync(ADMIN_PATH, 'utf8');
    expect(src).toMatch(/to=['"]upgrades['"]/);
    expect(src).toMatch(/Upgrades/);
  });

  it('App.tsx registers the upgrades route under /admin', () => {
    const src = readFileSync(APP_PATH, 'utf8');
    expect(src).toMatch(/path=['"]upgrades['"]\s+element=\{<AdminUpgrades\s*\/>\}/);
  });
});
