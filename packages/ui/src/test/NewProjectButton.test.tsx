/**
 * @vitest-environment jsdom
 *
 * CGLAB-172: creating a project from the sidebar.
 *
 * Today this lives behind the board's project picker — you open a modal to get
 * at it. In the sidebar it is a `+` next to the list it adds to, which is where
 * the eye already is. Kept as its own component so the shell stays a layout and
 * this stays testable on its own.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { NewProjectButton } from '../components/NewProjectButton';
import { api } from '../api';

vi.mock('../api', () => ({
  api: { createProject: vi.fn() },
}));

const onCreated = vi.fn();

const renderButton = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewProjectButton onCreated={onCreated} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.createProject).mockResolvedValue({ id: 'new-1', name: 'New One' } as never);
});
afterEach(() => cleanup());

describe('NewProjectButton', () => {
  it('shows only a labelled + until it is used', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /new project/i })).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('opens an inline field rather than a modal', () => {
    // The point of moving this out of the picker is to skip the modal.
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    expect(screen.getByRole('textbox')).toBeDefined();
  });

  it('focuses the field so you can just type', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('creates the project on Enter and hands back the new id', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New One' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'New One' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('refuses to create a project with a blank name', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('trims the name instead of storing the stray spaces', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Spaced  ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'Spaced' }));
  });

  it('cancels on Escape without creating anything', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it('closes the field once the project exists', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New One' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('keeps what you typed when the server rejects it', async () => {
    // Losing the name on failure means retyping it — the request failed, the
    // input did not.
    vi.mocked(api.createProject).mockRejectedValue(new Error('duplicate name'));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Taken' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/could not create/i)).toBeDefined());
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Taken');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('does not fire twice when Enter is pressed repeatedly', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'New One' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createProject).toHaveBeenCalledTimes(1);
  });
});
