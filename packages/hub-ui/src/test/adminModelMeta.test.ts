/**
 * adminModelMeta — validation + list helpers for Admin → Models metadata.
 *
 * These mirror the server's rules so the admin sees an inline message instead
 * of a failed request. The server stays authoritative: a divergence fails
 * closed (request rejected), never open (bad row stored).
 */
import { describe, it, expect } from 'vitest';
import {
  validateMetaRow, isHarnessName, sortMetaRows, filterMetaRows,
  licenseClassLabel, LICENSE_CLASSES, type ModelMetaRow,
} from '../pages/adminModelMeta';

const row = (model: string, source: 'seed' | 'admin' = 'seed'): ModelMetaRow => ({
  model, provider: 'Acme', licenseClass: 'open_weights', license: 'MIT', source,
});

const valid = {
  model: 'glm-5.2', provider: 'Z.ai', license: 'MIT', licenseClass: 'open_weights',
};

describe('validateMetaRow', () => {
  it('accepts a complete row', () => {
    expect(validateMetaRow(valid)).toBeNull();
    expect(validateMetaRow({ ...valid, licenseClass: 'commercial' })).toBeNull();
  });

  it('requires the model', () => {
    expect(validateMetaRow({ ...valid, model: '' })).toMatch(/Model is required/);
    expect(validateMetaRow({ ...valid, model: '   ' })).toMatch(/Model is required/);
  });

  it('requires a provider — an empty one renders an empty filter chip', () => {
    expect(validateMetaRow({ ...valid, provider: '' })).toMatch(/Provider is required/);
  });

  it('requires a licence name', () => {
    expect(validateMetaRow({ ...valid, license: '' })).toMatch(/License is required/);
  });

  it('rejects a licenseClass outside the two valid values', () => {
    expect(validateMetaRow({ ...valid, licenseClass: 'open_source' })).toMatch(/Open weights/);
  });

  it('enforces the length ceiling on each free-text field', () => {
    expect(validateMetaRow({ ...valid, model: 'z'.repeat(201) })).toMatch(/Model must be at most/);
    expect(validateMetaRow({ ...valid, provider: 'z'.repeat(201) })).toMatch(/Provider must be at most/);
    expect(validateMetaRow({ ...valid, license: 'z'.repeat(201) })).toMatch(/License must be at most/);
  });

  it('accepts a value at exactly the ceiling', () => {
    expect(validateMetaRow({ ...valid, provider: 'z'.repeat(200) })).toBeNull();
  });
});

describe('isHarnessName', () => {
  it('flags agent runtimes so they are not filed as models', () => {
    for (const h of ['claude-code', 'codex-cli', 'opencode', 'cursor', 'windsurf', 'pi']) {
      expect(isHarnessName(h)).toBe(true);
    }
  });

  it('is case-insensitive and trims', () => {
    expect(isHarnessName('  Claude-Code ')).toBe(true);
  });

  it('does not flag real models that share a vendor prefix', () => {
    expect(isHarnessName('claude-opus-4-8')).toBe(false);
    expect(isHarnessName('glm-5.2')).toBe(false);
  });
});

describe('sortMetaRows', () => {
  it('puts admin-edited rows first so the page is verifiable at a glance', () => {
    const sorted = sortMetaRows([row('a'), row('z', 'admin'), row('m')]);
    expect(sorted.map(r => r.model)).toEqual(['z', 'a', 'm']);
  });

  it('sorts alphabetically within each group', () => {
    const sorted = sortMetaRows([row('b'), row('a'), row('d', 'admin'), row('c', 'admin')]);
    expect(sorted.map(r => r.model)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('does not mutate the input', () => {
    const input = [row('b'), row('a', 'admin')];
    sortMetaRows(input);
    expect(input.map(r => r.model)).toEqual(['b', 'a']);
  });
});

describe('filterMetaRows', () => {
  const rows = [
    { ...row('glm-5.2'), provider: 'Z.ai', license: 'MIT' },
    { ...row('claude-opus-4-8'), provider: 'Anthropic', license: 'Proprietary (API only)' },
  ];

  it('returns everything for an empty or whitespace query', () => {
    expect(filterMetaRows(rows, '')).toHaveLength(2);
    expect(filterMetaRows(rows, '   ')).toHaveLength(2);
  });

  it('matches on model, provider or licence, case-insensitively', () => {
    expect(filterMetaRows(rows, 'GLM').map(r => r.model)).toEqual(['glm-5.2']);
    expect(filterMetaRows(rows, 'anthropic').map(r => r.model)).toEqual(['claude-opus-4-8']);
    expect(filterMetaRows(rows, 'proprietary').map(r => r.model)).toEqual(['claude-opus-4-8']);
  });

  it('returns nothing for a non-match rather than falling back to all', () => {
    expect(filterMetaRows(rows, 'zzz-nothing')).toEqual([]);
  });
});

describe('licenseClassLabel / LICENSE_CLASSES', () => {
  it('labels exactly the two supported classes', () => {
    expect(LICENSE_CLASSES.map(c => c.value)).toEqual(['open_weights', 'commercial']);
    expect(licenseClassLabel('open_weights')).toBe('Open weights');
    expect(licenseClassLabel('commercial')).toBe('Commercial / API only');
  });

  it('echoes an unknown value rather than mislabelling it', () => {
    expect(licenseClassLabel('open_source')).toBe('open_source');
  });
});
