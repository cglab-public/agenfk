/**
 * Tab labels for the shared flow editor.
 *
 * The editor is embedded in two hosts whose vocabulary differs, and the
 * difference is not cosmetic: in the hub admin, the "Community" tab lists
 * whatever repo `resolveRegistryRead` resolves to, which for an org that set a
 * private registry is the ORG'S OWN repo — so a tab labelled "Community" shows
 * private flows, and the org's flow list is not "mine" but the catalogue every
 * installation inherits.
 *
 * Labels are therefore supplied by the host. The defaults preserve the
 * standalone client's wording exactly, because there "My Flows" and
 * "Community" are both true.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TAB_LABELS, resolveTabLabels } from '../pages/adminFlowRegistry';

describe('hub flow-editor tab labels', () => {
  it('names the org catalogue "Org Flows", not "My Flows"', () => {
    // The hub admin edits the org-wide catalogue that every installation
    // inherits. "My" implies a personal list, which does not exist here.
    expect(DEFAULT_TAB_LABELS.myFlows).toBe('Org Flows');
  });

  it('labels the registry tab by the repo actually being listed', () => {
    // The decisive case: an org on a private registry must not see "Community".
    expect(resolveTabLabels({ isPublic: false, repo: 'cglab-PRIVATE/agenfk-flows' }).registry)
      .toBe('cglab-PRIVATE/agenfk-flows');
  });

  it('says "Community" only when the registry really is the public one', () => {
    expect(resolveTabLabels({ isPublic: true, repo: 'cglab-public/agenfk-flows' }).registry)
      .toBe('Community');
  });

  it('falls back to "Community" when the config has not loaded yet', () => {
    // The panel renders before GET /v1/admin/registry-config resolves. A null
    // config must not render an empty tab or a stale org name.
    expect(resolveTabLabels({ isPublic: null, repo: null }).registry).toBe('Community');
    expect(resolveTabLabels({}).registry).toBe('Community');
  });

  it('does not claim "Community" when the repo is private and isPublic is unknown', () => {
    // If the two fields arrive out of order, trust the repo over the flag:
    // mislabelling a private repo as Community is the bug being fixed.
    expect(resolveTabLabels({ isPublic: null, repo: 'cglab-PRIVATE/agenfk-flows' }).registry)
      .toBe('cglab-PRIVATE/agenfk-flows');
  });

  it('treats the public repo slug as public even if isPublic is false', () => {
    // Defensive: the server derives isPublic from the slug, so the two cannot
    // disagree. If a future edit lets them drift, the slug wins — it is what
    // resolveRegistryRead actually reads.
    expect(resolveTabLabels({ isPublic: false, repo: 'cglab-public/agenfk-flows' }).registry)
      .toBe('Community');
  });

  it('keeps both labels non-empty for every input shape', () => {
    // An empty tab label would render an unclickable-looking button.
    for (const cfg of [{}, { isPublic: true, repo: '' }, { isPublic: false, repo: '' }, { repo: undefined }]) {
      const l = resolveTabLabels(cfg);
      expect(l.myFlows.length, JSON.stringify(cfg)).toBeGreaterThan(0);
      expect(l.registry.length, JSON.stringify(cfg)).toBeGreaterThan(0);
    }
  });

  it('truncates a long repo name so the tab bar does not overflow', () => {
    // The tab bar is two flex-1 buttons in a modal; an unbounded repo name
    // pushes the second tab off-screen.
    const long = 'a-very-long-organization-name/a-very-long-repository-name-indeed';
    const label = resolveTabLabels({ isPublic: false, repo: long }).registry;
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label).toMatch(/…|\.\.\./);
  });

  it('keeps a normal-length repo name intact (no gratuitous truncation)', () => {
    expect(resolveTabLabels({ isPublic: false, repo: 'acme/flows' }).registry).toBe('acme/flows');
  });
});
