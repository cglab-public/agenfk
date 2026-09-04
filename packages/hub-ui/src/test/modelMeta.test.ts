/**
 * modelMeta (hub-ui) — facets derived from server-provided metadata.
 *
 * The classification lives in the hub\u2019s model_meta table; this module only
 * groups what the API already sent. So the tests here pin the DERIVATION and,
 * critically, the no-guess contract: a model the server could not classify must
 * land in a visible "unclassified" bucket, never inherit a vendor by string
 * similarity.
 */
import { describe, it, expect } from 'vitest';
import {
  modelMeta, providersFor, licenseClassesFor, modelsMatching,
  resolveMetaSelection, LICENSE_CLASS_LABEL, UNCLASSIFIED,
  type ModelFacetRow,
} from '../modelMeta';

const rows = (
  ...specs: Array<[string, string?, ('open_weights' | 'commercial')?, string?]>
): ModelFacetRow[] =>
  specs.map(([model, provider, licenseClass, license]) => ({
    model, provider, licenseClass, license,
  }));

const FIXTURE = rows(
  ['claude-opus-4-8', 'Anthropic', 'commercial', 'Proprietary (API only)'],
  ['glm-5.2', 'Z.ai', 'open_weights', 'MIT'],
  ['qwen3.8-max', 'Alibaba', 'commercial', 'Proprietary (API only)'],
  ['qwen3.8-27b', 'Alibaba', 'open_weights', 'Apache-2.0'],
  ['mystery-model'],
);

describe('modelMeta', () => {
  it('reads provider and class off the row the server sent', () => {
    expect(modelMeta('glm-5.2', FIXTURE)).toMatchObject({ provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' });
    expect(modelMeta('claude-opus-4-8', FIXTURE).licenseClass).toBe('commercial');
  });

  it('never guesses a model the server could not classify', () => {
    const m = modelMeta('mystery-model', FIXTURE);
    expect(m.provider).toBe(UNCLASSIFIED);
  });

  it('does not infer a vendor from a similar name', () => {
    // The old client-side seed would have matched "glm-*" here. Now the server
    // decides, so an unlisted model stays unclassified even though a sibling
    // of the same family is classified.
    expect(modelMeta('glm-9.9-not-in-response', FIXTURE).provider).toBe(UNCLASSIFIED);
  });

  it('treats a missing licenseClass as commercial, the conservative reading', () => {
    expect(modelMeta('x', rows(['x', 'Acme', undefined, 'MIT'])).licenseClass).toBe('commercial');
  });

  it('is empty-safe', () => {
    expect(modelMeta('anything', []).provider).toBe(UNCLASSIFIED);
  });

  it('labels the axis "Open weights", not "Open source"', () => {
    expect(LICENSE_CLASS_LABEL.open_weights).toBe('Open weights');
    expect(LICENSE_CLASS_LABEL.commercial).toBe('Commercial / API only');
  });
});

describe('providersFor / licenseClassesFor', () => {
  it('lists only what is present, alphabetical, unclassified last', () => {
    expect(providersFor(FIXTURE)).toEqual(['Alibaba', 'Anthropic', 'Z.ai', UNCLASSIFIED]);
  });

  it('de-duplicates a provider shared by several models', () => {
    expect(providersFor(rows(['a', 'Alibaba', 'open_weights'], ['b', 'Alibaba', 'commercial'])))
      .toEqual(['Alibaba']);
  });

  it('omits an absent license class', () => {
    expect(licenseClassesFor(rows(['a', 'Z.ai', 'open_weights']))).toEqual(['open_weights']);
    expect(licenseClassesFor(FIXTURE)).toEqual(['open_weights', 'commercial']);
  });
});

describe('modelsMatching', () => {
  it('returns everything when neither axis is selected (predicate semantics)', () => {
    expect(modelsMatching(FIXTURE, new Set(), new Set()).length).toBe(FIXTURE.length);
  });

  it('OR-combines within the provider axis', () => {
    expect(modelsMatching(FIXTURE, new Set(['Anthropic', 'Z.ai']), new Set()))
      .toEqual(['claude-opus-4-8', 'glm-5.2']);
  });

  it('OR-combines within the weights axis', () => {
    expect(modelsMatching(FIXTURE, new Set(), new Set(['open_weights'])))
      .toEqual(['glm-5.2', 'qwen3.8-27b']);
  });

  it('AND-combines the two axes', () => {
    expect(modelsMatching(FIXTURE, new Set(['Anthropic']), new Set(['open_weights']))).toEqual([]);
    expect(modelsMatching(FIXTURE, new Set(['Alibaba']), new Set(['commercial']))).toEqual(['qwen3.8-max']);
  });

  it('splits one family by class — the reason the seed is artifact-level', () => {
    const open = modelsMatching(FIXTURE, new Set(['Alibaba']), new Set(['open_weights']));
    expect(open).toEqual(['qwen3.8-27b']);
  });

  it('lets the unclassified bucket be selected', () => {
    expect(modelsMatching(FIXTURE, new Set([UNCLASSIFIED]), new Set())).toEqual(['mystery-model']);
  });
});

describe('resolveMetaSelection', () => {
  it('is a no-op with no meta selection — must NOT expand to every model', () => {
    expect(resolveMetaSelection(FIXTURE, new Set(['glm-5.2']), new Set(), new Set())).toEqual(['glm-5.2']);
    expect(resolveMetaSelection(FIXTURE, new Set(), new Set(), new Set())).toEqual([]);
  });

  it('adds every model the meta-selection resolves to', () => {
    expect(resolveMetaSelection(FIXTURE, new Set(), new Set(['Alibaba']), new Set()).sort())
      .toEqual(['qwen3.8-27b', 'qwen3.8-max']);
  });

  it('de-duplicates an explicit pick the meta-selection also resolves', () => {
    expect(resolveMetaSelection(FIXTURE, new Set(['glm-5.2']), new Set(['Z.ai']), new Set()))
      .toEqual(['glm-5.2']);
  });

  it('never drops an explicit pick the meta-filter would exclude', () => {
    const r = resolveMetaSelection(FIXTURE, new Set(['claude-opus-4-8']), new Set(), new Set(['open_weights']));
    expect(r).toContain('claude-opus-4-8');
    expect(r).toContain('glm-5.2');
  });
});
