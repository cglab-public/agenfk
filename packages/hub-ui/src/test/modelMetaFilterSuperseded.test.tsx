/**
 * @vitest-environment jsdom
 *
 * ModelMetaFilter while a PR-number search supersedes it (CGLAB-151). The
 * superseded facets are disabled and greyed rather than hidden, with their
 * selection intact — which puts this component in a state it never used to see:
 * buttons that are dead for a reason OTHER than "nothing left to add".
 *
 * The distinction is the whole test. A tooltip that says "Add 0 more Anthropic
 * models" on a button that is dead because a search switched the filter off tells
 * a reader who landed on a shared `?pr=57&model=` link that the filter is
 * exhausted, and they will conclude their selection is wrong when it is merely
 * paused.
 */
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelMetaFilter } from '../components/ModelMetaFilter';
import type { ModelFacetRow } from '../modelMeta';

const ROWS: ModelFacetRow[] = [
  { model: 'claude-opus-4-8', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
  { model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
];

const tree = (disabled: boolean) => (
  <ModelMetaFilter
    rows={ROWS}
    selected={new Set(['glm-5.2'])}
    onApply={vi.fn()}
    disabled={disabled}
  />
);

afterEach(() => cleanup());

describe('ModelMetaFilter while a PR search supersedes it', () => {
  it('names the real reason the vendor and licence buttons are dead', () => {
    render(tree(true));

    const anthropic = screen.getByRole('button', { name: /Anthropic/ });
    expect(anthropic).toBeDisabled();
    expect(anthropic.getAttribute('title')).toMatch(/supersede/i);
    expect(anthropic.getAttribute('title')).not.toMatch(/Add \d+ more/);
    expect(screen.getByRole('button', { name: /Open weights/ }).getAttribute('title'))
      .toMatch(/supersede/i);
  });

  it('keeps the ordinary tooltip when nothing supersedes the filter', () => {
    // Without this the fix could pass by blanking every tooltip, which would
    // remove the "why is this 0?" answer from normal use.
    render(tree(false));
    expect(screen.getByRole('button', { name: /Anthropic/ }).getAttribute('title'))
      .toMatch(/Add \d+ more Anthropic/);
    expect(screen.getByRole('button', { name: /Open weights/ }).getAttribute('title'))
      .toMatch(/publicly downloadable/i);
  });

  it('makes the licence disclosure inert while superseded', () => {
    // The accordion is telling the user these filters "do not apply". A summary
    // that still expands is a live control contradicting that.
    render(tree(true));
    const summary = screen.getByText(/License of 1 selected model/);
    expect(summary.className).toMatch(/pointer-events-none/);
    expect(summary.closest('details')).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves the licence disclosure usable when nothing supersedes it', () => {
    render(tree(false));
    const summary = screen.getByText(/License of 1 selected model/);
    expect(summary.className).not.toMatch(/pointer-events-none/);
    expect(summary.closest('details')).not.toHaveAttribute('aria-disabled');
  });
});
