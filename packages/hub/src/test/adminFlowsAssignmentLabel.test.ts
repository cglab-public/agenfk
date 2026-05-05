/**
 * Regression test for BUG b976a525: the AdminFlows project-overrides UI
 * showed raw project UUIDs in two places — the assignment chip (ScopeSection)
 * and the AddOverridePicker dropdown — even though the user wants the git
 * remote URL there. (Project IDs are unique-per-installation, so they're
 * meaningless to a hub admin who manages many installations.)
 *
 * Source-string assertions (matching the hub-ui test convention from
 * adminFlowShape.test.ts and the codebase-wide upgrade-tier.test.ts pattern)
 * lock in the post-fix render contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const PAGE_SRC = readFileSync(
  path.resolve(__dirname, '../../../hub-ui/src/pages/AdminFlows.tsx'),
  'utf8'
);

describe('BUG b976a525 — AdminFlows surfaces remoteUrl, not raw project UUID', () => {
  it('ProjectInfo carries an optional remoteUrl field', () => {
    expect(PAGE_SRC).toMatch(/interface\s+ProjectInfo[\s\S]{0,200}remoteUrl\s*:/);
  });

  it('Assignment carries an optional remoteUrl field', () => {
    expect(PAGE_SRC).toMatch(/interface\s+Assignment[\s\S]{0,500}remoteUrl\s*\??\s*:/);
  });

  it('ScopeSection chip renders remoteUrl with targetId fallback', () => {
    // After the fix, the chip renders `r.remoteUrl ?? r.targetId` (nullish coalescing)
    // OR an equivalent ternary like `r.remoteUrl ? r.remoteUrl : r.targetId`.
    // No bare `{r.targetId}` chip should remain.
    const chipMatch = PAGE_SRC.match(/className=\{[^}]*chipClass[\s\S]{0,300}\}\s*>([\s\S]{0,200})<\/span>/);
    expect(chipMatch).not.toBeNull();
    expect(chipMatch![1]).toMatch(/r\.remoteUrl/);
  });

  it('AddOverridePicker uses remoteUrl as the human label, projectId as the value', () => {
    // The picker map must produce an option whose `id` is the projectId (for
    // submission to the assignment endpoint) and whose `label` shows the
    // remote when available.
    const mapMatch = PAGE_SRC.match(
      /projectsQ\.data\s*\?\?\s*\[\]\)[\s\S]{0,400}\.map\([\s\S]{0,400}\)/
    );
    expect(mapMatch).not.toBeNull();
    expect(mapMatch![0]).toMatch(/id:\s*p\.projectId/);
    expect(mapMatch![0]).toMatch(/label:\s*p\.remoteUrl/);
  });
});
