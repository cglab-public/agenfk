/**
 * @vitest-environment jsdom
 *
 * GH-405: the Project (git remote) dropdown opened inside the filter fold and
 * was cut off at the fold's bottom edge — one option visible, the rest gone.
 * The accordion's section had `overflow-hidden`, which clips an absolutely
 * positioned popover, and its `backdrop-blur` makes it a stacking context of
 * its own, so the dashboard cards after it painted over whatever escaped.
 *
 * jsdom has no layout, so the guarantee is pinned on the classes that decide it:
 * nothing between the open popover and the page clips overflow, and the fold is
 * lifted above the content that follows it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { FilterAccordion } from '../components/FilterAccordion';
import { FacetMultiselect } from '../components/FacetMultiselect';

afterEach(cleanup);

const PROJECTS = Array.from({ length: 12 }, (_, i) => `git@github.com:acme/repo-${i}.git`);

function renderOpenFold() {
  const { container } = render(
    <div data-testid="page">
      <FilterAccordion activeCount={0} summary="7 days · all projects" open onOpenChange={() => {}}>
        <FacetMultiselect
          label="Project (git remote)"
          options={PROJECTS}
          selected={new Set()}
          onToggle={() => {}}
          onClear={() => {}}
          inlineThreshold={6}
          placeholder="Search projects…"
        />
      </FilterAccordion>
      <section data-testid="next-card">Tokens</section>
    </div>,
  );
  // Above the inline threshold the facet is a trigger that opens a popover.
  fireEvent.click(screen.getByRole('button', { name: /all 12/i }));
  const search = screen.getByPlaceholderText('Search projects…');
  return { container, search };
}

describe('FilterAccordion with an open facet popover (GH-405)', () => {
  it('no ancestor of the popover clips its overflow', () => {
    const { search } = renderOpenFold();
    const page = screen.getByTestId('page');
    // Walk from the popover's search box up to the page. The popover panel
    // itself may clip (it rounds its own corners); its ancestors must not.
    const panel = search.closest('[id]') as HTMLElement;
    expect(panel).not.toBeNull();
    const clipping: string[] = [];
    for (let el = panel.parentElement; el && el !== page; el = el.parentElement) {
      if (/\boverflow-(hidden|clip|auto|scroll|y-auto|y-hidden)\b/.test(el.className)) {
        clipping.push(`<${el.tagName.toLowerCase()} class="${el.className}">`);
      }
    }
    expect(clipping).toEqual([]);
  });

  it('lifts the fold above the content that follows it', () => {
    const { container } = renderOpenFold();
    const fold = container.querySelector('[data-testid="filter-header"]')!.closest('section')!;
    // backdrop-blur makes the fold a stacking context; without a z-index of its
    // own the next card (later in the DOM) paints over the popover.
    expect(fold.className).toMatch(/\brelative\b/);
    expect(fold.className).toMatch(/\bz-(\d+|\[\d+\])\b/);
  });

  it('draws the popover opaque, since it hangs over the cards below', () => {
    const { search } = renderOpenFold();
    const panel = search.closest('[id]') as HTMLElement;
    // A glass panel nested in the fold's backdrop-blur cannot blur what lies
    // outside the fold, so the cards below showed straight through the list.
    expect(panel.className).toMatch(/\bbg-surface\b/);
    expect(panel.className).not.toMatch(/\bbg-card-glass\b/);
  });
});
