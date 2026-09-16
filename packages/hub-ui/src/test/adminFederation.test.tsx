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

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A join token as the parent mints it: its own URL is signed into the body. */
const joinToken = (parentUrl: string) =>
  `${b64url({ orgId: 'group', nonce: 'n1', exp: Date.now() + 60_000, kind: 'child-hub', parentUrl })}.sig`;
/** One minted before the URL was signed in. */
const LEGACY_TOKEN = `${b64url({ orgId: 'group', nonce: 'n1', exp: Date.now() + 60_000, kind: 'child-hub' })}.sig`;

describe('Admin → Parent hub', () => {
  it('asks for the join token and nothing else — the URL rides inside it', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    expect(await screen.findByRole('textbox', { name: /join token/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /parent hub url/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /leave/i })).toBeNull();
  });

  it('shows where the pasted token will send this hub, before it is used', async () => {
    // The admin is pasting an opaque blob at a stranger's instruction. Showing
    // the decoded destination is the only chance they get to notice it is wrong.
    renderPage({ bound: false, outboxDepth: 0 });
    const box = await screen.findByRole('textbox', { name: /join token/i });
    fireEvent.change(box, { target: { value: joinToken('https://parent.example.com') } });
    expect(await screen.findByText('https://parent.example.com')).toBeInTheDocument();
  });

  it('joins with the trimmed token and the URL decoded from it', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    const token = joinToken('https://parent.example.com');
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: `  ${token}  ` } });
    post.mockResolvedValue({ data: { parentUrl: 'https://parent.example.com', childHubId: 'ch-1', state: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/federation/join', { inviteToken: token }));
  });

  it('will not submit a pre-upgrade token, and names the fix as upgrading the parent', async () => {
    // "Ask for a new token" is unachievable advice here: a parent running an
    // older version cannot mint one. The only way out is to upgrade it.
    renderPage({ bound: false, outboxDepth: 0 });
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: LEGACY_TOKEN } });
    expect(screen.getByRole('button', { name: /^join$/i })).toBeDisabled();
    expect(await screen.findByText(/upgraded/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a token naming a non-http destination, and says so', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    const evil = `${b64url({ orgId: 'g', nonce: 'n', exp: Date.now() + 60_000, kind: 'child-hub', parentUrl: 'javascript:alert(1)' })}.sig`;
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: evil } });
    expect(screen.getByRole('button', { name: /^join$/i })).toBeDisabled();
    expect(await screen.findByText(/upgraded/i)).toBeInTheDocument();
    expect(screen.queryByText(/javascript:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the host it will really contact, not the one the token reads as', async () => {
    // https://parent.example.com@evil.example.com reads as the first and
    // connects to the second. The confirmation line is the only control here,
    // so it has to show the second.
    renderPage({ bound: false, outboxDepth: 0 });
    const spoof = `${b64url({ orgId: 'g', nonce: 'n', exp: Date.now() + 60_000, kind: 'child-hub', parentUrl: 'https://parent.example.com@evil.example.com/x' })}.sig`;
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: spoof } });
    expect(await screen.findByText('https://evil.example.com/x')).toBeInTheDocument();
    expect(screen.queryByText(/parent\.example\.com@/)).toBeNull();
  });

  it('will not submit a token that is not a token', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: 'complete nonsense' } });
    expect(screen.getByRole('button', { name: /^join$/i })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends a roster name when one is given, and omits it when not', async () => {
    // Without a name every unconfigured child lands on the parent's board as
    // the internal org id, indistinguishable from its siblings.
    renderPage({ bound: false, outboxDepth: 0 });
    const token = joinToken('https://p.example.com');
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: token } });
    fireEvent.change(screen.getByRole('textbox', { name: /name on the parent/i }), { target: { value: '  acme-emea  ' } });
    post.mockResolvedValue({ data: { parentUrl: 'https://p.example.com', childHubId: 'ch-1', state: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: /^join$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/federation/join', {
      inviteToken: token, name: 'acme-emea',
    }));
  });

  it('surfaces the parent refusing the invite', async () => {
    renderPage({ bound: false, outboxDepth: 0 });
    fireEvent.change(await screen.findByRole('textbox', { name: /join token/i }), { target: { value: joinToken('https://p.example.com') } });
    post.mockRejectedValue({ response: { data: { error: 'invite token already used' } } });
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
