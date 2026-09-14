/**
 * @vitest-environment jsdom
 *
 * Admin → Parent hub (CGLAB-181). The rule this screen has to make legible:
 * a child hub cannot let itself out of a group. Leave stays disabled, with a
 * reason, until the parent has actually released it.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFederation } from '../pages/AdminFederation';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const del = api.delete as unknown as ReturnType<typeof vi.fn>;

const BOUND = {
  bound: true, parentUrl: 'https://parent.example.com', childHubId: 'ch-1',
  state: 'active', enrolledAt: '2026-09-01T10:00:00.000Z',
  outboxDepth: 0, releaseRequested: false, canLeave: false,
};
const RELEASED = { ...BOUND, state: 'revoked', canLeave: true, releaseRequested: true };

const renderPage = (data: unknown) => {
  get.mockImplementation(async () => ({ data }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AdminFederation /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => { get.mockReset(); post.mockReset(); del.mockReset(); });
afterEach(() => { cleanup(); get.mockReset(); post.mockReset(); del.mockReset(); });

describe('Admin → Parent hub', () => {
  it('offers the join form when this hub has no parent', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    expect(await screen.findByRole('textbox', { name: /parent hub url/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /join token/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /leave/i })).toBeNull();
  });

  it('joins with the trimmed url and token', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    await screen.findByRole('textbox', { name: /parent hub url/i });
    post.mockResolvedValue({ data: { parentUrl: 'https://parent.example.com', childHubId: 'ch-1', state: 'active' } });
    fireEvent.change(screen.getByRole('textbox', { name: /parent hub url/i }), { target: { value: '  https://parent.example.com  ' } });
    fireEvent.change(screen.getByRole('textbox', { name: /join token/i }), { target: { value: ' body.sig ' } });
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/federation/join', {
      parentUrl: 'https://parent.example.com', inviteToken: 'body.sig',
    }));
  });

  it('sends a roster name when one is given, and omits it when not', async () => {
    // Without a name every unconfigured child lands on the parent's board as
    // the internal org id, indistinguishable from its siblings.
    renderPage({ bound: false, outboxDepth: 0 });
    await screen.findByRole('textbox', { name: /parent hub url/i });
    post.mockResolvedValue({ data: { parentUrl: 'https://p.example.com', childHubId: 'ch-1', state: 'active' } });
    fireEvent.change(screen.getByRole('textbox', { name: /parent hub url/i }), { target: { value: 'https://p.example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: /join token/i }), { target: { value: 'tok' } });
    fireEvent.change(screen.getByRole('textbox', { name: /name on the parent/i }), { target: { value: '  acme-emea  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/federation/join', {
      parentUrl: 'https://p.example.com', inviteToken: 'tok', name: 'acme-emea',
    }));
  });

  it('surfaces the parent refusing the invite', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    await screen.findByRole('textbox', { name: /parent hub url/i });
    post.mockRejectedValue({ response: { data: { error: 'invite token already used' } } });
    fireEvent.change(screen.getByRole('textbox', { name: /parent hub url/i }), { target: { value: 'https://p.example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: /join token/i }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already used/i);
  });

  it('shows the parent it reports to, and what is waiting to be sent', async () => {
    renderPage({ ...BOUND, outboxDepth: 7 });
    expect(await screen.findByText(/parent\.example\.com/)).toBeInTheDocument();
    const label = screen.getByText(/waiting to send/i);
    expect(label.nextElementSibling).toHaveTextContent('7');
  });

  it('will not let the hub leave on its own, and says why', async () => {
    renderPage(BOUND);
    const leave = await screen.findByRole('button', { name: /leave/i });
    expect(leave).toBeDisabled();
    expect(screen.getByText(/only.*parent.*release|released by its parent/i)).toBeInTheDocument();
    fireEvent.click(leave);
    expect(del).not.toHaveBeenCalled();
  });

  it('asks the parent for release, with a reason', async () => {
    renderPage(BOUND);
    await screen.findByRole('button', { name: /request release/i });
    post.mockResolvedValue({ data: { ok: true } });
    fireEvent.change(screen.getByRole('textbox', { name: /reason/i }), { target: { value: 'splitting off' } });
    fireEvent.click(screen.getByRole('button', { name: /request release/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/federation/release-request', { reason: 'splitting off' }));
  });

  it('after asking, says it is waiting — and leave is still refused', async () => {
    renderPage({ ...BOUND, releaseRequested: true });
    expect(await screen.findByText(/waiting for the parent/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /leave/i })).toBeDisabled();
  });

  it('follows the server\'s canLeave verdict rather than second-guessing it', async () => {
    // If the UI recomputed the rule it could drift from the route that
    // enforces it, and the screen would offer a button the API refuses.
    renderPage({ ...BOUND, state: 'revoked', canLeave: false });
    expect(await screen.findByRole('button', { name: /leave/i })).toBeDisabled();
  });

  it('enables leave once the parent has released the hub, behind a confirmation', async () => {
    renderPage(RELEASED);
    const leave = await screen.findByRole('button', { name: /leave/i });
    expect(leave).toBeEnabled();
    fireEvent.click(leave);
    expect(del).not.toHaveBeenCalled();
    del.mockResolvedValue({ data: { bound: false } });
    fireEvent.click(await screen.findByRole('button', { name: /yes, leave/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/admin/federation'));
  });

  it('warns that leaving does not send what is still queued', async () => {
    renderPage({ ...RELEASED, outboxDepth: 12 });
    fireEvent.click(await screen.findByRole('button', { name: /^leave$/i }));
    expect(await screen.findByText(/12 queued item/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing will send them/i)).toBeInTheDocument();
  });

  it('says so when the binding cannot be read, rather than claiming no parent', async () => {
    renderPage({ bound: true, unreadable: true, error: 'Invalid encrypted blob format', outboxDepth: 0 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid encrypted blob/i);
    expect(screen.queryByRole('textbox', { name: /join token/i })).toBeNull();
  });
});
