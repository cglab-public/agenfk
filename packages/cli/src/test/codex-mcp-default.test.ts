/**
 * Behaviour tests for Codex defaulting to the MCP variant (CGLAB-15).
 *
 * Codex runs tools in a sandbox that often blocks outbound localhost, so the
 * agenfk CLI can't reach the local API server there. The MCP stdio server is not
 * subject to that restriction. So — unlike every other client, which is CLI-only
 * unless --with-mcp — Codex gets the MCP server registered BY DEFAULT; only an
 * explicit --no-mcp opts out.
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — .mjs helper has no .d.ts.
import { shouldRegisterCodexMcp } from '../../../../scripts/install-helpers.mjs';

describe('shouldRegisterCodexMcp — Codex defaults to MCP', () => {
  it('registers MCP by default (no flags), overriding the global CLI-only default', () => {
    expect(shouldRegisterCodexMcp()).toBe(true);
    expect(shouldRegisterCodexMcp({})).toBe(true);
    expect(shouldRegisterCodexMcp({ withMcp: false })).toBe(true);
  });

  it('still registers MCP when the global opt-in is set', () => {
    expect(shouldRegisterCodexMcp({ withMcp: true })).toBe(true);
  });

  it('only --no-mcp opts Codex out', () => {
    expect(shouldRegisterCodexMcp({ noMcp: true })).toBe(false);
    // --no-mcp wins even if --with-mcp is also somehow present.
    expect(shouldRegisterCodexMcp({ withMcp: true, noMcp: true })).toBe(false);
  });

  it('makes a --no-mcp opt-out sticky via the persisted preference', () => {
    // A prior opt-out (config.codexMcp === false) survives a later flag-less run
    // (e.g. `agenfk upgrade`), so Codex MCP is NOT silently re-registered.
    expect(shouldRegisterCodexMcp({ persistedCodexMcp: false })).toBe(false);
    // A persisted opt-in (or absence) keeps the default-on behaviour.
    expect(shouldRegisterCodexMcp({ persistedCodexMcp: true })).toBe(true);
    expect(shouldRegisterCodexMcp({ persistedCodexMcp: undefined })).toBe(true);
  });

  it('lets an explicit --with-mcp re-enable Codex after a persisted opt-out', () => {
    expect(shouldRegisterCodexMcp({ withMcp: true, persistedCodexMcp: false })).toBe(true);
  });

  it('lets --no-mcp override a persisted opt-in', () => {
    expect(shouldRegisterCodexMcp({ noMcp: true, persistedCodexMcp: true })).toBe(false);
  });
});
