/**
 * @vitest-environment jsdom
 *
 * STORY a44f3697 — the page an operator pastes an admin recovery token into.
 * The hub logs the token at boot when AGENFK_HUB_RESET_ADMIN_EMAIL names an
 * admin; redeeming it sets that admin's password and signs them in, so they
 * land where the broken sign-in is repaired: Admin → Sign-in.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { RecoverPage } from '../pages/Recover';
import { LoginPage } from '../pages/Login';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async () => ({ data: { password: false, google: true, entra: false, requiresSetup: false } }));
});
afterEach(cleanup);

function mount(path = '/recover') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/recover" element={<RecoverPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/admin/auth" element={<div data-testid="admin-auth">sign-in settings</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
const fill = (token: string, password: string) => {
  fireEvent.change(screen.getByLabelText('Recovery token'), { target: { value: token } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
};

describe('admin recovery page', () => {
  it('labels its fields and keeps the submit off until both are filled', () => {
    mount();
    expect(screen.getByLabelText('Recovery token')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    const submit = screen.getByRole('button', { name: /recover/i });
    expect(submit).toBeDisabled();
    fill('t'.repeat(43), 'short');
    expect(submit).toBeDisabled();
    fill('t'.repeat(43), 'long-enough-1');
    expect(submit).toBeEnabled();
  });

  it('redeems the token (trimmed) and lands on Admin → Sign-in', async () => {
    post.mockResolvedValue({ data: { id: 'u', email: 'a@x', role: 'admin', orgId: 'org' } });
    mount();
    fill(`  ${'t'.repeat(43)}\n`, 'long-enough-1');
    fireEvent.click(screen.getByRole('button', { name: /recover/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/recover', { token: 't'.repeat(43), password: 'long-enough-1' }));
    expect(await screen.findByTestId('admin-auth')).toBeInTheDocument();
  });

  it("shows the hub's refusal", async () => {
    post.mockRejectedValue({ response: { data: { error: 'Invalid or expired recovery token' } } });
    mount();
    fill('t'.repeat(43), 'long-enough-1');
    fireEvent.click(screen.getByRole('button', { name: /recover/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired recovery token');
  });

  it('says where the token comes from', () => {
    mount();
    expect(document.body.textContent).toMatch(/AGENFK_HUB_RESET_ADMIN_EMAIL/);
  });
});
