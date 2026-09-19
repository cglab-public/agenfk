/**
 * Typing into a herdr pane (96953f6a / CGLAB-266).
 *
 * Reading somebody else's agent was the first half. This is the second: two
 * panes on this machine sit `blocked` waiting for a person, and the answer is
 * usually one character. Seeing that and being unable to answer it is the
 * feature half-built.
 *
 * The line these tests defend is that TYPING AND SUBMITTING ARE TWO ACTS.
 * `pane.send_text` never appends Enter - putting a command in somebody's
 * terminal and running it are different things, and the UI has to keep them
 * different or the distinction the protocol drew is lost on the way to a button.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { HerdrPaneView } from '../components/HerdrPaneView';
import type { ProjectPaneRow } from '../herdrTreeRows';

const PANE: ProjectPaneRow = {
  paneId: 'w8:p1',
  socketPath: '/cfg/herdr/herdr.sock',
  agentId: 'pi',
  title: 'π - cglab-agentic-catalog',
  projectName: 'cglab-agentic-catalog',
  state: 'blocked',
  needsAPerson: true,
};

/** Every POST the component made, in order, with what it carried. */
let posts: { path: string; body: Record<string, unknown> }[] = [];
let postStatus = 200;
let postBody: unknown = { ok: true };

beforeEach(() => {
  posts = [];
  postStatus = 200;
  postBody = { ok: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || init.method !== 'POST') {
      return new Response(JSON.stringify({ text: 'on screen', truncated: false }), { status: 200 });
    }
    // Split the string, not `new URL` - API_URL is relative under test and
    // parsing it throws before anything is recorded, which reads as "the
    // component never posted" when in fact the assertion harness broke.
    posts.push({ path: String(url).split('?')[0].split('/').pop()!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(postBody), { status: postStatus });
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(pane: ProjectPaneRow = PANE): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HerdrPaneView pane={pane} />
    </QueryClientProvider>,
  );
}

const type = (s: string): void => {
  fireEvent.change(screen.getByTestId('herdr-input'), { target: { value: s } });
};

/* ── the two acts ──────────────────────────────────────────────────────── */

describe('Send', () => {
  it('types the text and THEN presses Enter, in that order', async () => {
    mount();
    type('2');
    fireEvent.click(screen.getByTestId('herdr-send'));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].path).toBe('text');
    expect(posts[0].body.text).toBe('2');
    expect(posts[1].path).toBe('keys');
    expect(posts[1].body.keys).toEqual(['Enter']);
  });

  it('carries the socket, because the pane id alone does not say who answers', async () => {
    /*
     * herdr can hold several sessions, each its own socket. Asking the wrong
     * one gets `pane_not_found` for a pane that is very much alive - and on a
     * WRITE, guessing would type into a different person's terminal.
     */
    mount();
    type('hello');
    fireEvent.click(screen.getByTestId('herdr-send'));
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0].body.socket).toBe('/cfg/herdr/herdr.sock');
  });
});

describe('Type', () => {
  it('does NOT press Enter', async () => {
    /*
     * The whole reason this button exists. `pane.send_text` appends nothing,
     * and a UI that always submitted would have made that guarantee
     * unreachable from the only place a person can use it.
     */
    mount();
    type('rm -rf something');
    fireEvent.click(screen.getByTestId('herdr-type'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe('text');
    expect(posts.some(p => p.path === 'keys')).toBe(false);
  });
});

/* ── one tap ───────────────────────────────────────────────────────────── */

describe('the quick keys', () => {
  it('sends the key alone, with no text before it', async () => {
    mount();
    fireEvent.click(screen.getByTestId('herdr-key-Escape'));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].path).toBe('keys');
    expect(posts[0].body.keys).toEqual(['Escape']);
  });

  it('offers the ones a blocked agent is actually waiting on', () => {
    /*
     * MEASURED on this machine: the prompts in flight answer to `1`, `2` and
     * `3`, and herdr refuses `C-c` while accepting `ctrl+c`. A keypad of tmux
     * spellings would look right and send nothing.
     */
    mount();
    for (const k of ['1', '2', 'Enter', 'Escape', 'ctrl+c']) {
      expect(screen.getByTestId(`herdr-key-${k}`)).toBeTruthy();
    }
  });
});

/* ── when it does not work ─────────────────────────────────────────────── */

describe('a refused write', () => {
  it('says so instead of looking like it worked', async () => {
    postStatus = 400;
    postBody = { error: 'herdr refused that key' };
    mount();
    fireEvent.click(screen.getByTestId('herdr-key-Escape'));
    expect((await screen.findByTestId('herdr-send-error')).textContent).toMatch(/refused/i);
  });

  it('keeps the draft, so nothing a person typed is thrown away', async () => {
    postStatus = 500;
    mount();
    type('a long message worth keeping');
    fireEvent.click(screen.getByTestId('herdr-send'));
    await screen.findByTestId('herdr-send-error');
    expect((screen.getByTestId('herdr-input') as HTMLInputElement).value).toBe('a long message worth keeping');
  });

  it('clears the draft when it DID work', async () => {
    mount();
    type('done');
    fireEvent.click(screen.getByTestId('herdr-send'));
    await waitFor(() => expect((screen.getByTestId('herdr-input') as HTMLInputElement).value).toBe(''));
  });
});

/* ── what it refuses to offer ──────────────────────────────────────────── */

describe('a pane that cannot be written to', () => {
  it('offers no input at all when the session is unknown', () => {
    /*
     * No socket means no way to know WHICH pane `w8:p1` is. Reading the wrong
     * one shows the wrong screen; writing the wrong one types into it.
     */
    mount({ ...PANE, socketPath: '' });
    expect(screen.queryByTestId('herdr-input')).toBeNull();
    expect(screen.queryByTestId('herdr-send')).toBeNull();
  });
});
