/**
 * @vitest-environment jsdom
 *
 * [UX] Installations lead with the person: the admin scans people, versions
 * and last-seen, so the person comes first, the 36-character id shrinks to a
 * short one, dead installs carry a "silent Nd" chip, and the row actions sit
 * in a per-row menu whose items say whose row they act on.
 */
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminInstallations } from '../pages/Admin';
import { silentDays } from '../pages/installationStaleness';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const del = api.delete as unknown as ReturnType<typeof vi.fn>;

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
const CAROL = '3f0c1a2b-1111-4222-8333-944445555666';
const BOB = '9a8b7c6d-2222-4333-8444-a55556666777';
const RETIRED = 'aa11bb22-3333-4444-8555-c66667777888';
const NOEMAIL = 'dd44ee55-4444-4555-8666-d77778888999';
const ROWS = [
  { id: CAROL, agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: ago(3), firstSeen: ago(60), lastSeen: ago(1), osUser: 'carol', gitName: 'Carol Diaz', gitEmail: 'carol@acme.dev' },
  { id: BOB, agenfkVersion: '1.9.0', agenfkVersionUpdatedAt: ago(40), firstSeen: ago(60), lastSeen: ago(20), osUser: 'bob', gitName: 'Bob Silva', gitEmail: 'bob@acme.dev' },
  { id: NOEMAIL, agenfkVersion: '2.0.0', agenfkVersionUpdatedAt: ago(3), firstSeen: ago(60), lastSeen: ago(1), osUser: 'dana', gitName: null, gitEmail: null },
];
const RETIRED_ROW = { id: RETIRED, agenfkVersion: '1.0.0', agenfkVersionUpdatedAt: ago(90), firstSeen: ago(200), lastSeen: ago(90), osUser: 'eve', gitName: 'Eve Park', gitEmail: 'eve@acme.dev', retired: true };

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AdminInstallations /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset(); post.mockReset(); del.mockReset();
  del.mockResolvedValue({ data: {} });
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/v1/admin/installations')) return { data: url.includes('includeRetired') ? [...ROWS, RETIRED_ROW] : ROWS };
    if (url === '/v1/admin/hidden-users') return { data: [] };
    return { data: [] };
  });
  post.mockResolvedValue({ data: {} });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('silentDays', () => {
  it('is the whole days since last seen once that reaches 14, otherwise null', () => {
    expect(silentDays(ago(20), NOW)).toBe(20);
    expect(silentDays(ago(14), NOW)).toBe(14);
    expect(silentDays(ago(13.5), NOW)).toBeNull();
  });

  it('is null for an install that never reported a time', () => {
    expect(silentDays(null, NOW)).toBeNull();
  });
});

describe('Installations table', () => {
  it('leads with the person, then a short installation id', async () => {
    mount();
    await screen.findByText('Carol Diaz');
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent?.trim());
    expect(headers.slice(0, 2)).toEqual(['Person', 'Installation']);
    const row = screen.getByText('Carol Diaz').closest('tr')!;
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('Carol Diaz');
    expect(cells[0]).toHaveTextContent('carol@acme.dev');
    expect(within(cells[1]).getByText(CAROL.slice(0, 8))).toHaveAttribute('title', CAROL);
    expect(row).not.toHaveTextContent(CAROL); // the full id is on hover, not in the row
  });

  it('marks an install that has been silent for 14+ days, and only that one', async () => {
    mount();
    await screen.findByText('Bob Silva');
    const bob = screen.getByText('Bob Silva').closest('tr')!;
    const carol = screen.getByText('Carol Diaz').closest('tr')!;
    expect(within(bob).getByText('silent 20d')).toBeInTheDocument();
    expect(within(carol).queryByText(/^silent/)).toBeNull();
  });

  it('keeps the row actions in a menu named for the person', async () => {
    mount();
    await screen.findByText('Bob Silva');
    const bob = screen.getByText('Bob Silva').closest('tr')!;
    expect(within(bob).queryByRole('button', { name: /^retire$/i })).toBeNull(); // not loose on the row
    const trigger = within(bob).getByRole('button', { name: 'Actions for Bob Silva' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Actions for Bob Silva' });
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent?.trim())).toEqual([
      'Hide Bob Silva',
      "Retire Bob Silva's installation",
    ]);
  });

  it('runs the chosen action and closes the menu', async () => {
    mount();
    await screen.findByText('Bob Silva');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Retire Bob Silva's installation" }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/v1/admin/installations/${BOB}/retire`));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the menu on Escape without acting', async () => {
    mount();
    await screen.findByText('Bob Silva');
    const trigger = screen.getByRole('button', { name: 'Actions for Bob Silva' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('hides the person from the menu', async () => {
    mount();
    await screen.findByText('Bob Silva');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bob Silva' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide Bob Silva' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/hidden-users', { userKey: 'bob@acme.dev' }));
  });

  it('offers no Hide for an install with no git email, and names it as the table does', async () => {
    mount();
    await screen.findByText('dana');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for dana' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent?.trim());
    expect(items).toEqual(["Retire dana's installation"]);
  });

  it('restores a retired installation from its menu', async () => {
    mount();
    await screen.findByText('Bob Silva');
    fireEvent.click(screen.getByRole('button', { name: /show retired/i }));
    await screen.findByText('Eve Park');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Eve Park' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Restore Eve Park's installation" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/v1/admin/installations/${RETIRED}/retire`));
  });

  it('focuses the first item on open, moves with the arrows, and returns focus on Escape', async () => {
    mount();
    await screen.findByText('Bob Silva');
    const trigger = screen.getByRole('button', { name: 'Actions for Bob Silva' });
    fireEvent.click(trigger);
    const [hideItem, retireItem] = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(hideItem).toHaveFocus();
    fireEvent.keyDown(hideItem, { key: 'ArrowDown' });
    expect(retireItem).toHaveFocus();
    fireEvent.keyDown(retireItem, { key: 'ArrowDown' });
    expect(hideItem).toHaveFocus(); // wraps
    fireEvent.keyDown(hideItem, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('Tab closes the menu and hands focus back to its button, not off the page', async () => {
    mount();
    await screen.findByText('Bob Silva');
    const trigger = screen.getByRole('button', { name: 'Actions for Bob Silva' });
    fireEvent.click(trigger);
    fireEvent.keyDown(within(screen.getByRole('menu')).getAllByRole('menuitem')[0], { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on a click outside, without acting', async () => {
    mount();
    await screen.findByText('Bob Silva');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bob Silva' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('renders the menu outside the table, so the scroller cannot clip it', async () => {
    mount();
    await screen.findByText('Bob Silva');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Bob Silva' }));
    expect(screen.getByRole('menu').closest('table')).toBeNull();
  });
});
