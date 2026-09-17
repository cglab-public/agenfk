/**
 * @vitest-environment jsdom
 *
 * FacetMultiselect's `disabled` state (CGLAB-151) — added because the PR
 * Overview's PR-number search supersedes the Developer/Model facets. The state
 * has three jobs, and the third is the one that is easy to get wrong:
 *  1. the controls are inert (a control that looks live while its selection
 *     changes nothing is a lie);
 *  2. the selection stays visible, so clearing the search restores it in front
 *     of the user rather than silently from storage;
 *  3. an already-open popover must not linger over now-inert options — that is a
 *     keyboard trap, the same defect the filter accordion's `hidden` body exists
 *     to avoid.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { FacetMultiselect } from '../components/FacetMultiselect';

// Above the inline threshold, so this is the popover layout (the one with the
// open/closed state worth testing).
const OPTIONS = Array.from({ length: 10 }, (_, i) => `model-${i}`);
const onToggle = vi.fn();
const onClear = vi.fn();

const tree = (disabled: boolean) => (
  <FacetMultiselect
    label="Model"
    options={OPTIONS}
    selected={new Set(['model-1'])}
    onToggle={onToggle}
    onClear={onClear}
    inlineThreshold={6}
    disabled={disabled}
  />
);

afterEach(() => cleanup());

describe('FacetMultiselect disabled', () => {
  it('leaves the trigger live when not disabled', () => {
    render(tree(false));
    expect(screen.getByRole('button', { name: /1 selected/ })).not.toBeDisabled();
  });

  it('disables the trigger and the selected-chip remover', () => {
    render(tree(true));
    expect(screen.getByRole('button', { name: /1 selected/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove model-1' })).toBeDisabled();
  });

  it('keeps the selection visible while disabled, so clearing the search restores it', () => {
    render(tree(true));
    expect(screen.getByText('1 selected · 10 total')).toBeInTheDocument();
  });

  it('closes a popover that is open when the facet becomes disabled', () => {
    const { rerender } = render(tree(false));
    fireEvent.click(screen.getByRole('button', { name: /1 selected/ }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    rerender(tree(true));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('disables the flat-layout Clear button as well as the popover footer one', () => {
    // The popover footer grew the `disabled` guard; the flat layout's Clear did
    // not, so the same action was inert in one layout and live in the other.
    // Reachable today: below the threshold the facet never opens a popover, so a
    // disabled facet really does show this button.
    render(
      <FacetMultiselect
        label="Type"
        options={['EPIC', 'STORY', 'TASK', 'BUG']}
        selected={new Set(['BUG'])}
        onToggle={onToggle}
        onClear={onClear}
        inlineThreshold={6}
        disabled
      />,
    );
    const clear = screen.getByRole('button', { name: /Clear \(1\)/ });
    expect(clear).toBeDisabled();
    fireEvent.click(clear);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('counts what the popover actually holds, not just the option list', () => {
    // The list this trigger opens is options ∪ selection. Quoting `options.length`
    // advertised a smaller facet than the popover held — reachable on Org and
    // UserDetail from a stale `?projects=` link, with no PR search involved.
    render(
      <FacetMultiselect
        label="Project"
        options={['git@github.com:acme/a.git', 'git@github.com:acme/b.git']}
        selected={new Set(['git@github.com:acme/gone.git'])}
        onToggle={onToggle}
        onClear={onClear}
        inlineThreshold={1}
      />,
    );
    expect(screen.getByRole('button', { name: /1 selected · 3 total/ })).toBeInTheDocument();
  });

  it('still renders when the option universe is empty but a selection is live', () => {
    // The answer to a PR search that MISSES contains no models and no developers.
    // `if (options.length === 0) return null` therefore hid the whole facet, so a
    // shared `?pr=999&model=…` link showed a filter in force with no control to
    // see it or clear it. Only "nothing offered AND nothing chosen" means no
    // control.
    render(
      <FacetMultiselect
        label="Model"
        options={[]}
        selected={new Set(['glm-5.2'])}
        onToggle={onToggle}
        onClear={onClear}
        inlineThreshold={6}
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: 'glm-5.2' })).toBeDisabled();
  });

  it('shows a selected value that the option list does not contain', () => {
    // A search HIT has exactly one developer and one model, so a selection made
    // before the search is no longer in `options`. Rendering `options` alone left
    // the header reading "Clear (1)" above chips that did not include what was
    // selected — a control misreporting its own state.
    render(
      <FacetMultiselect
        label="Developer"
        options={['bob@acme.com']}
        selected={new Set(['carol@acme.com'])}
        onToggle={onToggle}
        onClear={onClear}
        inlineThreshold={6}
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: 'carol@acme.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bob@acme.com' })).toBeInTheDocument();
  });
});
