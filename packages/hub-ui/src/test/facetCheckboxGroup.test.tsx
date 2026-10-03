/**
 * @vitest-environment jsdom
 *
 * Facet popover is a labelled checkbox group (TASK 52701b97, story "Names and
 * state on every control"). It was a listbox whose options wrapped buttons,
 * with no names: the trigger read "All 12" with nothing saying which filter,
 * and the choices announced no checked state. Now the trigger is a disclosure
 * named for its facet, and the choices are checkboxes in a group named for it.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { FacetMultiselect } from '../components/FacetMultiselect';

const OPTIONS = ['https://github.com/acme/api.git', 'https://github.com/acme/web.git', 'c', 'd', 'e', 'f', 'g', 'h'];
const short = (v: string) => v.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

function facet(props: Partial<React.ComponentProps<typeof FacetMultiselect>> = {}) {
  const onToggle = vi.fn();
  const utils = render(
    <FacetMultiselect
      label="Project"
      options={OPTIONS}
      selected={new Set(['https://github.com/acme/api.git'])}
      onToggle={onToggle}
      onClear={() => {}}
      optionLabel={short}
      inlineThreshold={6}
      {...props}
    />,
  );
  return { onToggle, ...utils };
}
const trigger = () => screen.getByRole('button', { name: /^Project/ , expanded: false }) as HTMLElement;

afterEach(cleanup);

describe('the popover trigger', () => {
  it('is a disclosure named for its facet and its summary', () => {
    facet();
    const t = trigger();
    expect(t).toHaveAccessibleName('Project 1 selected · 8 total');
    expect(t).toHaveAttribute('aria-expanded', 'false');
    // A disclosure, not a listbox popup: what opens is a group of checkboxes.
    expect(t).not.toHaveAttribute('aria-haspopup');
  });

  it('points at the panel it opens', () => {
    facet();
    fireEvent.click(trigger());
    const t = screen.getByRole('button', { name: /^Project/, expanded: true });
    const panel = document.getElementById(t.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(within(panel!).getByRole('group', { name: 'Project' })).toBeInTheDocument();
  });
});

describe('the open popover', () => {
  it('holds a checkbox per option, named by its label and checked when selected', () => {
    facet();
    fireEvent.click(trigger());
    const group = screen.getByRole('group', { name: 'Project' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(OPTIONS.length);
    expect(within(group).getByRole('checkbox', { name: 'acme/api' })).toBeChecked();
    expect(within(group).getByRole('checkbox', { name: 'acme/web' })).not.toBeChecked();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('toggles by the raw value', () => {
    const { onToggle } = facet();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/web' }));
    expect(onToggle).toHaveBeenCalledWith('https://github.com/acme/web.git');
  });

  it('names its search box for the facet', () => {
    facet();
    fireEvent.click(trigger());
    expect(screen.getByRole('textbox', { name: 'Search Project' })).toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    facet();
    fireEvent.click(trigger());
    const search = screen.getByRole('textbox', { name: 'Search Project' });
    search.focus();

    fireEvent.keyDown(search, { key: 'Escape' });

    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it('does not pull focus back on Escape once focus has left the panel', () => {
    // Another control that handles Escape (a dialog, another facet) must keep
    // its focus: this panel only returns focus it held.
    facet();
    fireEvent.click(trigger());
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    fireEvent.keyDown(elsewhere, { key: 'Escape' });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('positions each option so a focused one scrolls into view', () => {
    // The checkbox is sr-only (position:absolute). Without a positioned label
    // its containing block is the panel, not the scrolling list, so tabbing
    // to an option below the fold left the list unscrolled. Measured in Chrome;
    // jsdom has no layout, so the class that fixes it is pinned.
    facet();
    fireEvent.click(trigger());
    const box = screen.getByRole('checkbox', { name: 'acme/web' });
    expect(box.closest('label')!.className.split(/\s+/)).toContain('relative');
  });

  it('leaves focus alone when an outside click closes it', () => {
    facet();
    fireEvent.click(trigger());
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.mouseDown(outside);

    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('selected chips', () => {
  it('name what they remove by its label, not the raw value', () => {
    facet();
    expect(screen.getByRole('button', { name: 'Remove acme/api' })).toBeInTheDocument();
  });
});

describe('inline chips (few options)', () => {
  it('are pressed-state buttons in a group named for the facet', () => {
    const { onToggle } = facet({ options: ['EPIC', 'STORY', 'TASK'], selected: new Set(['STORY']), optionLabel: undefined });
    const group = screen.getByRole('group', { name: 'Project' });
    expect(within(group).getByRole('button', { name: 'STORY' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'EPIC' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(within(group).getByRole('button', { name: 'EPIC' }));
    expect(onToggle).toHaveBeenCalledWith('EPIC');
  });

  it('stay inert while the facet is disabled', () => {
    facet({ options: ['EPIC', 'STORY'], selected: new Set(['STORY']), optionLabel: undefined, disabled: true });
    for (const b of within(screen.getByRole('group', { name: 'Project' })).getAllByRole('button')) expect(b).toBeDisabled();
  });
});
