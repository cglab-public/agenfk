/**
 * @vitest-environment jsdom
 *
 * Admin → JIRA (CGLAB-412). The admin registers the org's Atlassian OAuth app
 * once; each person then connects their own JIRA from their board, through
 * the hub. What this pins is the wiring:
 *  - the callback URL to register on the Atlassian app is shown, verbatim;
 *  - saving PUTs the trimmed id, and sends a secret only when one was typed
 *    (the server keeps the stored one otherwise, and never echoes it);
 *  - the page says how many installations are connected, and "Disconnect
 *    everyone" posts the org-wide disconnect;
 *  - there is no admin-side Connect: connecting is each user's own act.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminJira } from '../pages/AdminJira';
import { AdminLayout } from '../pages/Admin';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const put = api.put as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

const REDIRECT = 'https://hub.acme.test/v1/jira/oauth/callback';
const UNCONFIGURED = { configured: false, clientId: '', clientSecretSet: false, connectedCount: 0, redirectUri: REDIRECT };
const CONFIGURED = { ...UNCONFIGURED, configured: true, clientId: 'cid-1', clientSecretSet: true, connectedCount: 3 };

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/jira']}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="jira" element={<AdminJira />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Admin → JIRA', () => {
  it('is reachable from the admin nav', async () => {
    get.mockResolvedValue({ data: UNCONFIGURED });
    renderPage();
    expect(screen.getByRole('link', { name: /jira/i })).toHaveAttribute('href', '/admin/jira');
  });

  it('loads the org app from the admin endpoint and shows the callback URL to register', async () => {
    get.mockResolvedValue({ data: UNCONFIGURED });
    renderPage();
    expect(await screen.findByText(REDIRECT)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/v1/admin/jira');
  });

  it('has no admin-side Connect: each user connects their own JIRA from their board', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    renderPage();
    await screen.findByText(REDIRECT);
    expect(screen.queryByRole('link', { name: /connect/i })).not.toBeInTheDocument();
    expect(screen.getByText(/from their (own )?board/i)).toBeInTheDocument();
  });

  it('saving PUTs the trimmed client id and the secret', async () => {
    get.mockResolvedValue({ data: UNCONFIGURED });
    put.mockResolvedValue({ data: { ...CONFIGURED, connectedCount: 0 } });
    renderPage();
    await screen.findByText(REDIRECT);
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: '  cid-1  ' } });
    fireEvent.change(screen.getByLabelText(/client secret/i), { target: { value: 'csecret-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/jira', { clientId: 'cid-1', clientSecret: 'csecret-1' }));
  });

  it('with a stored secret, a blank secret field is not sent (the server keeps the stored one)', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    put.mockResolvedValue({ data: CONFIGURED });
    renderPage();
    const secret = await screen.findByLabelText(/client secret/i);
    expect(secret).toHaveAttribute('placeholder', expect.stringMatching(/leave blank to keep/i));
    expect(secret).toHaveAttribute('type', 'password');
    expect((screen.getByLabelText(/client id/i) as HTMLInputElement).value).toBe('cid-1');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/jira', { clientId: 'cid-1' }));
  });

  it('a save error from the hub is shown', async () => {
    get.mockResolvedValue({ data: UNCONFIGURED });
    put.mockRejectedValue({ response: { data: { error: 'clientSecret is required' } } });
    renderPage();
    await screen.findByText(REDIRECT);
    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: 'cid-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/clientSecret is required/)).toBeInTheDocument();
  });

  it('shows how many installations are connected', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    renderPage();
    expect(await screen.findByTestId('jira-connected-count')).toHaveTextContent('3');
  });

  it('"Disconnect everyone" asks first, then posts the org-wide disconnect', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    post.mockResolvedValue({ data: { ...CONFIGURED, connectedCount: 0 } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /disconnect everyone/i }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/jira/disconnect-all'));
    expect(await screen.findByTestId('jira-connected-count')).toHaveTextContent('0');
  });

  it('a declined confirmation disconnects no one', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    vi.mocked(window.confirm).mockReturnValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /disconnect everyone/i }));
    expect(post).not.toHaveBeenCalled();
  });

  it('tells the admin to set the Atlassian app\'s Distribution to Sharing, or only its contributors can connect', async () => {
    get.mockResolvedValue({ data: UNCONFIGURED });
    renderPage();
    const step = await screen.findByTestId('jira-distribution-step');
    expect(step.textContent).toMatch(/distribution/i);
    expect(step.textContent).toMatch(/sharing/i);
    expect(step.textContent).toMatch(/contributors/i);
  });

  it('warns that changing the client id disconnects everyone', async () => {
    get.mockResolvedValue({ data: CONFIGURED });
    renderPage();
    expect(await screen.findByText(/changing the client id disconnects everyone/i)).toBeInTheDocument();
  });
});
