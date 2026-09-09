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
});
