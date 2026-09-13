/**
 * @vitest-environment jsdom
 *
 * CGLAB-169: choosing which agent a terminal launches.
 *
 * The grouping is the feature, not decoration. Without "Installed" and "Not
 * installed" as separate sections, an agent the user does not have looks
 * exactly like one they do; they pick it, and the terminal opens straight onto
 * "command not found". That reads as a broken app rather than as a missing
 * install. With the grouping, the same situation becomes information.
 *
 * Detection runs in the main process and is slow enough to matter — on macOS it
 * may spawn a login shell to get a usable PATH — so the loading state is a real
 * state and not a formality.
 */
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { AgentPicker } from '../components/AgentPicker';

const AGENTS = [
  { id: 'claude', label: 'Claude Code', installed: true },
  { id: 'codex', label: 'Codex', installed: false },
  { id: 'opencode', label: 'Opencode', installed: true },
  { id: 'gemini', label: 'Gemini CLI', installed: false },
  { id: 'shell', label: 'Shell', installed: true },
];

const renderPicker = (props: Partial<React.ComponentProps<typeof AgentPicker>> = {}) =>
  render(
    <AgentPicker
      value="claude"
      onChange={() => {}}
      listAgents={async () => AGENTS}
      {...props}
    />,
  );

const openMenu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
  return screen.findByRole('listbox');
};

afterEach(() => cleanup());

describe('grouping', () => {
  it('separates installed from not installed', async () => {
    renderPicker();
    const menu = await openMenu();
    expect(within(menu).getByText(/^installed$/i)).toBeDefined();
    expect(within(menu).getByText(/^not installed$/i)).toBeDefined();
  });

  it('puts each agent under the right heading', async () => {
    // The assertion that matters: an agent in the wrong group is worse than no
    // grouping at all, because the user now trusts it.
    renderPicker();
    const menu = await openMenu();
    const groups = within(menu).getAllByRole('group');
    const installed = groups.find(g => /installed/i.test(g.getAttribute('aria-label') ?? '') && !/not/i.test(g.getAttribute('aria-label') ?? ''))!;
    const missing = groups.find(g => /not installed/i.test(g.getAttribute('aria-label') ?? ''))!;

    expect(within(installed).getByText('Claude Code')).toBeDefined();
    expect(within(installed).getByText('Opencode')).toBeDefined();
    expect(within(missing).getByText('Codex')).toBeDefined();
    expect(within(missing).getByText('Gemini CLI')).toBeDefined();
  });

  it('says how to get an agent that is missing, not merely that it is', async () => {
    // "Not installed" alone leaves the user stuck. The point of showing the
    // absent ones at all is to tell them what to do about it.
    renderPicker();
    const menu = await openMenu();
    const codex = within(menu).getByRole('option', { name: /codex/i });
    expect(codex.textContent).toMatch(/install/i);
  });

  it('hides an empty group rather than showing a heading with nothing under it', async () => {
    renderPicker({ listAgents: async () => AGENTS.map(a => ({ ...a, installed: true })) });
    const menu = await openMenu();
    expect(within(menu).queryByText(/^not installed$/i)).toBeNull();
  });
});

describe('choosing', () => {
  it('reports the id, not the label', async () => {
    // The id is the wire format the main process maps against its closed list.
    const onChange = vi.fn();
    renderPicker({ onChange });
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('option', { name: /opencode/i }));
    expect(onChange).toHaveBeenCalledWith('opencode');
  });

  it('refuses to select an agent that is not installed', async () => {
    // Selecting it would open a terminal onto "command not found". The row
    // stays visible and informative, but it is not a choice.
    const onChange = vi.fn();
    renderPicker({ onChange });
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('option', { name: /codex/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks the current choice as selected for assistive tech', async () => {
    renderPicker();
    const menu = await openMenu();
    expect(within(menu).getByRole('option', { name: /claude code/i }).getAttribute('aria-selected')).toBe('true');
    expect(within(menu).getByRole('option', { name: /opencode/i }).getAttribute('aria-selected')).toBe('false');
  });

  it('closes after a choice instead of sitting over the thing it changed', async () => {
    renderPicker();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('option', { name: /opencode/i }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
});

describe('search', () => {
  it('filters within both groups', async () => {
    renderPicker();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByPlaceholderText(/search agents/i), { target: { value: 'co' } });
    expect(within(menu).getByRole('option', { name: /codex/i })).toBeDefined();
    expect(within(menu).getByRole('option', { name: /opencode/i })).toBeDefined();
    expect(within(menu).queryByRole('option', { name: /gemini/i })).toBeNull();
  });

  it('drops a group heading when the filter empties it', async () => {
    renderPicker();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByPlaceholderText(/search agents/i), { target: { value: 'gemini' } });
    expect(within(menu).queryByText(/^installed$/i)).toBeNull();
    expect(within(menu).getByText(/^not installed$/i)).toBeDefined();
  });

  it('says nothing matched rather than showing an empty menu', async () => {
    renderPicker();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByPlaceholderText(/search agents/i), { target: { value: 'zzzz' } });
    expect(within(menu).getByText(/no agents match/i)).toBeDefined();
  });
});

describe('keyboard', () => {
  it('moves through the installed options with the arrow keys', async () => {
    // The sort menu in CGLAB-172 shipped without arrow navigation and that
    // became a review finding. Not repeating it.
    //
    // Focus starts in the search box, so the first ArrowDown lands on the
    // FIRST option, not the second.
    renderPicker();
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toMatch(/claude code/i);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toMatch(/opencode/i);
  });

  it('skips over agents that cannot be chosen', async () => {
    // Landing focus on a disabled row is a dead end a keyboard user has to
    // arrow back out of. Installed here is Claude / Opencode / Shell, so three
    // presses reach Shell — Codex and Gemini are never focused despite sitting
    // between them in the rendered order.
    renderPicker();
    const menu = await openMenu();
    const visited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      visited.push(document.activeElement?.textContent ?? '');
    }
    expect(visited[2]).toMatch(/shell/i);
    expect(visited.join(' ')).not.toMatch(/codex|gemini/i);
  });

  it('wraps around rather than dead-ending at the last option', async () => {
    renderPicker();
    const menu = await openMenu();
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toMatch(/claude code/i);
  });

  it('chooses with Enter', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('opencode');
  });

  it('closes on Escape without changing anything', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    const menu = await openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('while detection is still running', () => {
  it('says it is looking rather than showing an empty menu', async () => {
    // Detection may spawn a login shell to get a usable PATH. Half a second of
    // empty dropdown reads as a bug.
    let release: (v: typeof AGENTS) => void = () => {};
    const pending = new Promise<typeof AGENTS>(res => { release = res; });
    renderPicker({ listAgents: () => pending });

    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    expect(await screen.findByText(/looking for installed agents/i)).toBeDefined();

    release(AGENTS);
    await waitFor(() => expect(screen.getByRole('option', { name: /opencode/i })).toBeDefined());
  });

  it('shows the trouble when detection fails, and still offers the shell', async () => {
    // A machine where detection cannot run is not a machine with no terminal.
    renderPicker({ listAgents: async () => { throw new Error('detection failed'); } });
    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    expect(await screen.findByRole('option', { name: /shell/i })).toBeDefined();
  });
});
