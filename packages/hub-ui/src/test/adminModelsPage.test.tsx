/**
 * @vitest-environment jsdom
 *
 * Admin → Models page. The grouping/validation rules are covered in
 * adminModels.test.ts; what matters here is the wiring a unit test cannot see:
 *  - the desired name is the column that groups, with spellings under it;
 *  - adding posts the TRIMMED pair (a pasted trailing space would otherwise
 *    make an alias that can never match);
 *  - client-side validation blocks the request and shows why;
 *  - a server 409 is surfaced rather than swallowed;
 *  - deleting targets the right alias;
 *  - the overview queries are invalidated, since that table is the thing that
 *    actually changes.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminModels } from '../pages/AdminModels';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;
const del = api.delete as unknown as ReturnType<typeof vi.fn>;

const RESPONSE = {
  mappings: [
    {
      aliasModel: 'qwen38-27b', canonicalModel: 'qwen3.8:27b',
      createdByUserId: 'u1', createdByEmail: 'admin@acme.com',
      createdAt: '2026-09-01T10:00:00.000Z',
    },
  ],
  observed: [
    { model: 'glm-5.2', prs: 40, canonicalModel: 'glm-5.2', isMapped: false },
    { model: 'qwen38-27b', prs: 2, canonicalModel: 'qwen3.8:27b', isMapped: true },
    { model: 'qwen3.8:27b', prs: 1, canonicalModel: 'qwen3.8:27b', isMapped: false },
  ],
};

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AdminModels /></MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: RESPONSE });
  post.mockReset().mockResolvedValue({ data: {} });
  del.mockReset().mockResolvedValue({ data: { removed: true } });
});

afterEach(() => { cleanup(); });

describe('AdminModels', () => {
  it('shows the desired name as the group, with the reported spelling under it', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('qwen3.8:27b')).toBeInTheDocument());
    // the alias is shown as folded in, not as its own model
    expect(screen.getByText('qwen38-27b')).toBeInTheDocument();
    // and the group total is the sum, not either row alone
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('leaves an unmapped model as its own row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('glm-5.2')).toBeInTheDocument());
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('posts the trimmed pair when adding', async () => {
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.change(screen.getByLabelText(/reported today as/i), { target: { value: '  qwen-3.8-27b  ' } });
    fireEvent.change(screen.getByLabelText(/show as \(desired name\)/i), { target: { value: '  qwen3.8:27b ' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/admin/models/mappings', {
      aliasModel: 'qwen-3.8-27b', canonicalModel: 'qwen3.8:27b',
    }));
  });

  it('blocks a mapping of a name to itself without hitting the server', async () => {
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.change(screen.getByLabelText(/reported today as/i), { target: { value: 'glm-5.2' } });
    fireEvent.change(screen.getByLabelText(/show as \(desired name\)/i), { target: { value: 'glm-5.2' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(post).not.toHaveBeenCalled();
  });

  it('surfaces a server conflict instead of failing silently', async () => {
    post.mockRejectedValue({ response: { data: { error: '"qwen38-27b" is already mapped to "other".' } } });
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.change(screen.getByLabelText(/reported today as/i), { target: { value: 'brand-new' } });
    fireEvent.change(screen.getByLabelText(/show as \(desired name\)/i), { target: { value: 'qwen3.8:27b' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already mapped to "other"'));
  });

  it('deletes the alias of the row it was clicked on', async () => {
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.click(screen.getByTitle(/unmap "qwen38-27b"/i));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/admin/models/mappings/qwen38-27b'));
  });

  it('does not delete when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockImplementation(() => false);
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.click(screen.getByTitle(/unmap "qwen38-27b"/i));
    await new Promise(r => setTimeout(r, 20));
    expect(del).not.toHaveBeenCalled();
  });

  it('invalidates the PR Overview queries, which is what this page actually changes', async () => {
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));

    fireEvent.change(screen.getByLabelText(/reported today as/i), { target: { value: 'x-alias' } });
    fireEvent.change(screen.getByLabelText(/show as \(desired name\)/i), { target: { value: 'x-name' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    // refetched after the mutation lands: the overview table must stop showing
    // the split immediately, not on the next hard reload.
    await waitFor(() => expect(get.mock.calls.filter(c => c[0] === '/v1/admin/models').length).toBeGreaterThan(1), {
      timeout: 2000,
    });
  });

  it('explains an empty hub rather than showing a blank table', async () => {
    get.mockResolvedValue({ data: { mappings: [], observed: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/no PR events with a model/i)).toBeInTheDocument());
  });

  it('offers observed ids and existing desired names as suggestions', async () => {
    renderPage();
    await waitFor(() => screen.getByText('glm-5.2'));
    // datalist elements are only useful if the inputs actually point at them.
    const aliasInput = screen.getByLabelText(/reported today as/i) as HTMLInputElement;
    const canonicalInput = screen.getByLabelText(/show as \(desired name\)/i) as HTMLInputElement;
    expect(aliasInput.getAttribute('list')).toBe('observed-model-ids');
    expect(canonicalInput.getAttribute('list')).toBe('known-canonical-names');
    const options = (id: string) => Array.from(
      document.querySelectorAll(`datalist#${id} option`),
    ).map(o => o.getAttribute('value'));
    expect(options('observed-model-ids')).toEqual(expect.arrayContaining(['glm-5.2', 'qwen38-27b']));
    expect(options('known-canonical-names')).toEqual(['qwen3.8:27b']);
  });
});
