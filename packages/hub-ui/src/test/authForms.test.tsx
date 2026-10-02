/**
 * @vitest-environment jsdom
 *
 * Sign-in and setup forms with real labels (STORY eb4d1c52). Both forms used
 * placeholders as labels: the hint vanished on the first keystroke, password
 * managers had nothing to go on, and after a first-run setup the admin landed
 * on the sign-in page with no word that it had worked.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { LoginPage } from '../pages/Login';
import { SetupPage } from '../pages/Setup';
import { Button } from '../components/ui';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

let requiresSetup = false;
beforeEach(() => {
  get.mockReset(); post.mockReset();
  requiresSetup = false;
  get.mockImplementation(async () => ({ data: { password: true, google: false, entra: false, requiresSetup } }));
});
afterEach(cleanup);

/** Exposes the router state the sign-in page is left with. */
function StateProbe() {
  const state = useLocation().state;
  return <div data-testid="router-state">{JSON.stringify(state ?? null)}</div>;
}

function mount(path: string, state?: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[{ pathname: path, state }]}>
          <Routes>
            <Route path="/login" element={<><LoginPage /><StateProbe /></>} />
            <Route path="/setup" element={<SetupPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe('sign-in', () => {
  it('labels its fields and tells the browser what they hold', async () => {
    mount('/login');
    const email = await screen.findByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('type', 'email');
    // "username" is what password managers pair with a password field.
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  it('shows the hub logo', async () => {
    mount('/login');
    expect(await screen.findByTestId('logo-wordmark')).toBeInTheDocument();
  });

  it('says nothing about setup when arrived at normally', async () => {
    mount('/login');
    await screen.findByLabelText('Email');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('first-run setup', () => {
  beforeEach(() => { requiresSetup = true; });

  it('labels its fields, with the password rule tied to the password', async () => {
    mount('/setup');
    const token = await screen.findByLabelText('Bootstrap token');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('Admin email')).toHaveAttribute('autocomplete', 'username');
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveAccessibleDescription(/at least 8 characters/i);
  });

  it('shows the hub logo', async () => {
    mount('/setup');
    expect(await screen.findByTestId('logo-wordmark')).toBeInTheDocument();
  });

  it('lands on sign-in with a notice that the admin account exists', async () => {
    post.mockResolvedValue({ data: {} });
    mount('/setup');
    fireEvent.change(await screen.findByLabelText('Bootstrap token'), { target: { value: 'tok-123' } });
    fireEvent.change(screen.getByLabelText('Admin email'), { target: { value: 'admin@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'longenough' } });
    // The sign-in page asks the hub again; setup is now done.
    requiresSetup = false;
    fireEvent.click(screen.getByRole('button', { name: 'Create admin' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Admin account created. Sign in with it.');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

describe('the setup notice', () => {
  const ADMIN_CREATED = { notice: 'admin-created' };

  it('is read once: the router state is cleared so a reload or Back does not repeat it', async () => {
    mount('/login', ADMIN_CREATED);
    expect(await screen.findByRole('status')).toHaveTextContent('Admin account created');
    expect(screen.getByTestId('router-state')).toHaveTextContent('null');
    // Still on screen for this visit.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('goes once the admin tries to sign in', async () => {
    post.mockRejectedValue({ response: { data: { error: 'Invalid credentials' } } });
    mount('/login', ADMIN_CREATED);
    await screen.findByRole('status');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@x.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('errors', () => {
  it('a failed setup is announced', async () => {
    requiresSetup = true;
    post.mockRejectedValue({ response: { data: { error: 'Bad bootstrap token' } } });
    mount('/setup');
    fireEvent.change(await screen.findByLabelText('Bootstrap token'), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText('Admin email'), { target: { value: 'admin@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'longenough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad bootstrap token');
  });
});

describe('a disabled primary button', () => {
  it('turns neutral instead of a faded brand colour that still looks clickable', () => {
    render(<Button variant="primary" disabled>Create admin</Button>);
    const cls = screen.getByRole('button').className.split(/\s+/);
    // Neutral, but still a visible button: no half opacity on top of a fill the
    // colour of the card, and an edge that shows.
    expect(cls).toEqual(expect.arrayContaining(['disabled:opacity-100', 'disabled:bg-canvas', 'disabled:text-ink-tertiary', 'disabled:border-ink-tertiary/40']));
  });
});
