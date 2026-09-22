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
import { AgentPicker, SEARCHABLE_AT } from '../components/AgentPicker';

// Both groups populated, because the grouping is what this file is about.
const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', installed: true },
  { id: 'codex', label: 'Codex', installed: false },
  { id: 'gemini', label: 'Gemini CLI', installed: true },
  { id: 'pi', label: 'Pi', installed: false },
  { id: 'shell', label: 'Shell', installed: true },
];

const renderPicker = (props: Partial<React.ComponentProps<typeof AgentPicker>> = {}) =>
  render(
    <AgentPicker
      value="claude-code"
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
    expect(within(installed).getByText('Gemini CLI')).toBeDefined();
    expect(within(missing).getByText('Codex')).toBeDefined();
    expect(within(missing).getByText('Pi')).toBeDefined();
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
    fireEvent.click(within(menu).getByRole('option', { name: /gemini/i }));
    expect(onChange).toHaveBeenCalledWith('gemini');
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
    expect(within(menu).getByRole('option', { name: /gemini/i }).getAttribute('aria-selected')).toBe('false');
  });

  it('closes after a choice instead of sitting over the thing it changed', async () => {
    renderPicker();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('option', { name: /gemini/i }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
});

describe('search', () => {
  /*
   * A ROSTER BIG ENOUGH TO NEED ONE. The dropdown only grows a search above
   * SEARCHABLE_AT, because the product's five agents fit on screen and a
   * filter over a list you can already read in full reads as "it is only
   * showing claude" — which is how this was reported.
   */
  const MANY = Array.from({ length: SEARCHABLE_AT + 1 }, (_, i) => ({
    id: `filler-${i}`, label: `Filler ${i}`, installed: true,
  }));
  const searchable = async () => [...AGENTS, ...MANY];

  it('is absent when the whole list fits on screen', async () => {
    renderPicker();
    const menu = await openMenu();
    expect(within(menu).queryByPlaceholderText(/search agents/i)).toBeNull();
    // And the agents themselves are what is shown instead.
    expect(within(menu).getByRole('option', { name: /claude code/i })).toBeDefined();
    expect(within(menu).getByRole('option', { name: /codex/i })).toBeDefined();
  });

  it('filters within both groups', async () => {
    renderPicker({ listAgents: searchable });
    const menu = await openMenu();
    // 'co' matches "Claude Code" (installed) and "Codex" (not installed), so
    // the filter has to reach inside both sections rather than one.
    fireEvent.change(within(menu).getByPlaceholderText(/search agents/i), { target: { value: 'co' } });
    expect(within(menu).getByRole('option', { name: /claude code/i })).toBeDefined();
    expect(within(menu).getByRole('option', { name: /codex/i })).toBeDefined();
    expect(within(menu).queryByRole('option', { name: /shell/i })).toBeNull();
  });

  it('drops a group heading when the filter empties it', async () => {
    renderPicker({ listAgents: searchable });
    const menu = await openMenu();
    // Only a not-installed agent matches, so the Installed heading must go
    // rather than sit over an empty section.
    fireEvent.change(within(menu).getByPlaceholderText(/search agents/i), { target: { value: 'pi' } });
    expect(within(menu).queryByText(/^installed$/i)).toBeNull();
    expect(within(menu).getByText(/^not installed$/i)).toBeDefined();
  });

  it('says nothing matched rather than showing an empty menu', async () => {
    renderPicker({ listAgents: searchable });
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
    expect(document.activeElement?.textContent).toMatch(/gemini/i);
  });

  it('skips over agents that cannot be chosen', async () => {
    // Landing focus on a disabled row is a dead end a keyboard user has to
    // arrow back out of. Installed here is Claude / Gemini / Shell, so three
    // presses reach Shell — Codex and Pi are never focused despite sitting
    // between them in the rendered order.
    renderPicker();
    const menu = await openMenu();
    const visited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      visited.push(document.activeElement?.textContent ?? '');
    }
    expect(visited[2]).toMatch(/shell/i);
    expect(visited.join(' '), 'focus landed on a row that cannot be chosen').not.toMatch(/codex|\bPi\b/);
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
    expect(onChange).toHaveBeenCalledWith('gemini');
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
    await waitFor(() => expect(screen.getByRole('option', { name: /gemini/i })).toBeDefined());
  });

  it('shows the trouble when detection fails, and still offers the shell', async () => {
    // A machine where detection cannot run is not a machine with no terminal.
    renderPicker({ listAgents: async () => { throw new Error('detection failed'); } });
    fireEvent.click(await screen.findByRole('button', { name: /claude code/i }));
    expect(await screen.findByRole('option', { name: /shell/i })).toBeDefined();
  });
});

describe('agent marks', () => {
  it('gives every offered agent a distinguishable mark', async () => {
    // Not the fallback dot: an agent added without one still lines up, which
    // means the omission is invisible unless something asserts it.
    renderPicker();
    const menu = await openMenu();
    for (const agent of AGENTS) {
      const row = within(menu).getByRole('option', { name: new RegExp(agent.label, 'i') });
      const mark = row.querySelector('[data-agent-mark]');
      expect(mark, `"${agent.id}" has no mark`).not.toBeNull();
      expect(mark!.getAttribute('data-agent-mark'), `"${agent.id}" fell back to the generic dot`)
        .toBe(agent.id);
    }
  });

  it('draws the vendors’ own marks, not placeholder geometry', async () => {
    // All four carry real brand path data now, inlined from @lobehub/icons.
    // An earlier version of this comment said Claude and Gemini came from
    // simple-icons and the other two were geometric stand-ins — that package
    // is no longer a dependency at all, and codex carries a full-fidelity
    // OpenAI path.
    renderPicker();
    const menu = await openMenu();
    const claude = within(menu).getByRole('option', { name: /claude code/i })
      .querySelector('[data-agent-mark="claude-code"]')!;
    // A filled brand path, not stroked geometry. `currentColor` counts: the
    // OpenAI mark is monochrome by design and inherits the text colour, so
    // requiring a hex here would force a wrong answer in light mode.
    expect(claude.getAttribute('fill')).toMatch(/^(#|currentColor)/);
    expect(claude.querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(200);
  });
});


/*
 * Dismissal, which this menu did not have.
 *
 * It was `absolute z-20` inside its own wrapper — clipped by the panel, and
 * any click elsewhere landed on something that took focus. Becoming a portal
 * at z-60 put it ABOVE the modal it belongs to, so "click somewhere else"
 * stopped being a way out: you could open this, click the project picker, and
 * end up with two listboxes open at once.
 */
describe('pressing outside the menu', () => {
  it('closes it', async () => {
    renderPicker();
    await openMenu();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('does not close on a press inside its own list', async () => {
    // The portal is outside the button in the DOM and inside this control in
    // every sense that matters; closing on the way down over an option would
    // unmount it before the click could land — the same defect the project
    // picker had.
    renderPicker();
    const menu = await openMenu();
    fireEvent.mouseDown(menu);
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('chooses the agent when the whole gesture lands on an option', async () => {
    const onChange = vi.fn();
    renderPicker({ onChange });
    await openMenu();
    // An INSTALLED one: the picker refuses the others by design, so choosing
    // codex here would have tested that refusal and called it a regression.
    const option = screen.getByRole('option', { name: /gemini/i });
    fireEvent.mouseDown(option);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('gemini');
  });

  it('Escape closes the menu without reaching the screen behind it', async () => {
    // The old handler was a React keydown on the menu: it only fired with
    // focus inside, and it could not stop the panel's own document listener.
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      renderPicker();
      await openMenu();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });
});
