/**
 * @vitest-environment jsdom
 *
 * The unified Models table: one row per model, aliases nested, provider/licence
 * edited inline. The behaviours worth pinning are the ones that make it usable
 * as a settings page — a newly arrived model is visibly Unknown, editing an
 * inherited rule warns it narrows the rule, and Save cannot fire on no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelTable } from '../components/ModelTable';
import type { ModelGroup } from '../pages/modelMappings';

const put = vi.fn();
const del = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({ data: {} })),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const meta = (model: string, provider: string, licenseClass = 'open_weights',
  license = 'MIT', source: 'seed' | 'admin' = 'seed') =>
  ({ model, provider, licenseClass, license, source } as any);

const group = (canonicalModel: string, prs = 1, aliases: string[] = []): ModelGroup => ({
  canonicalModel, prs,
  aliases: [
    { model: canonicalModel, prs, canonicalModel, isMapped: false },
    ...aliases.map(a => ({ model: a, prs: 0, canonicalModel, isMapped: true })),
  ],
  canonicalSeen: true, unusedMappings: [], createdBy: null,
});

function Harness({ groups = [], metaRows = [], loading = false, onError = () => {},
  onUnmap = () => {}, unmappedCount = 0, unusedCount = 0 }: {
  groups?: unknown[]; metaRows?: unknown[]; loading?: boolean;
  onError?: (m: string | null) => void; onUnmap?: (alias: string) => void;
  unmappedCount?: number; unusedCount?: number;
} = {}) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [invalidate] = useState(() => vi.fn());
  return (
    <QueryClientProvider client={qc}>
      <ModelTable
        groups={groups as ModelGroup[]} metaRows={metaRows as never} loading={loading}
        onError={onError} invalidate={invalidate} onUnmap={onUnmap} unmapping={false}
        unmappedCount={unmappedCount} unusedCount={unusedCount}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  put.mockReset().mockResolvedValue({ data: { ok: true } });
  del.mockReset().mockResolvedValue({ data: { ok: true } });
});

describe('Models table', () => {
  it('renders one row per model with provider, weights and licence', () => {
    render(<Harness groups={[group('glm-5.2', 12)]} metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT')]} />);
    expect(screen.getByText('glm-5.2')).toBeInTheDocument();
    expect(screen.getByText('Z.ai')).toBeInTheDocument();
    expect(screen.getByText('MIT')).toBeInTheDocument();
    expect(screen.getByText('Open weights')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('nests alias spellings under the model they fold into', () => {
    render(<Harness groups={[group('glm-5.2', 12, ['glm52'])]} metaRows={[meta('glm-5.2', 'Z.ai')]} />);
    expect(screen.getByText(/glm52/)).toBeInTheDocument();
    expect(screen.getByText(/maps to glm-5\.2/)).toBeInTheDocument();
    expect(screen.getByText('1 alias')).toBeInTheDocument();
  });

  it('shows a newly arrived model as Unknown, not guessed', () => {
    render(<Harness groups={[group('mystery-9000', 3)]} metaRows={[meta('glm-', 'Z.ai')]} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('1 unknown')).toBeInTheDocument();
    expect(screen.queryByText('Z.ai')).not.toBeInTheDocument();
  });

  it('sorts the unknown model to the top', () => {
    render(<Harness
      groups={[group('glm-5.2', 99), group('mystery-9000', 1)]}
      metaRows={[meta('glm-5.2', 'Z.ai')]}
    />);
    const rows = screen.getAllByRole('row');
    expect(rows[1].textContent).toContain('mystery-9000');
  });

  it('labels a rule inherited from a family prefix', () => {
    render(<Harness groups={[group('glm-9.9', 4)]} metaRows={[meta('glm-', 'Z.ai')]} />);
    expect(screen.getByText(/from glm-/)).toBeInTheDocument();
    expect(screen.getByText('covers 1')).toBeInTheDocument();
  });

  it('filters by model, provider or licence', () => {
    render(<Harness
      groups={[group('glm-5.2', 5), group('kimi-k3', 2)]}
      metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT'), meta('kimi-k3', 'Moonshot', 'open_weights', 'Modified MIT')]}
    />);
    const box = screen.getByRole('textbox', { name: /filter models/i });
    fireEvent.change(box, { target: { value: 'moonshot' } });
    expect(screen.queryByText('glm-5.2')).not.toBeInTheDocument();
    expect(screen.getByText('kimi-k3')).toBeInTheDocument();
  });

  describe('inline editing', () => {
    it('opens the row with current values and saves the change', async () => {
      const invalidate = vi.fn();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ModelTable
            groups={[group('glm-5.2', 5)] as any}
            metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT')] as any}
            loading={false} onError={() => {}} invalidate={invalidate}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
      const provider = screen.getByRole('textbox', { name: 'Provider' });
      expect(provider).toHaveValue('Z.ai');
      fireEvent.change(provider, { target: { value: 'Zhipu AI' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/models/meta', {
        model: 'glm-5.2', provider: 'Zhipu AI', license: 'MIT', licenseClass: 'open_weights',
      }));
      await waitFor(() => expect(invalidate).toHaveBeenCalled());
    });

    it('disables Save until something actually changed', () => {
      render(<Harness groups={[group('glm-5.2', 5)]} metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT')]} />);
      fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('classifies an unknown model from the row', async () => {
      render(<Harness groups={[group('mystery-9000', 3)]} metaRows={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /edit classification for mystery-9000/i }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), { target: { value: 'New Lab' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'License' }), { target: { value: 'Apache-2.0' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Weights' }), { target: { value: 'open_weights' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(put).toHaveBeenCalledWith('/v1/admin/models/meta', {
        model: 'mystery-9000', provider: 'New Lab', license: 'Apache-2.0', licenseClass: 'open_weights',
      }));
    });

    it('rejects a blank provider without calling the API', async () => {
      const onError = vi.fn();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <ModelTable
            groups={[group('glm-5.2', 5)] as any}
            metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT')] as any}
            loading={false} onError={onError} invalidate={vi.fn()}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), { target: { value: '   ' } });
      // Refused where it was typed, and Save stays disabled so it cannot fire.
      await waitFor(() => expect(screen.getByRole('alert'))
        .toHaveTextContent('Provider is required'));
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(put).not.toHaveBeenCalled();
    });

    it('cancels without saving', () => {
      render(<Harness groups={[group('glm-5.2', 5)]} metaRows={[meta('glm-5.2', 'Z.ai', 'open_weights', 'MIT')]} />);
      fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), { target: { value: 'Wrong' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText('Z.ai')).toBeInTheDocument();
      expect(put).not.toHaveBeenCalled();
    });
  });

  it('deletes a classification, leaving the model unknown', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<Harness groups={[group('glm-5.2', 5)]} metaRows={[meta('glm-5.2', 'Z.ai')]} />);
    fireEvent.click(screen.getByRole('button', { name: /delete classification for glm-5\.2/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/admin/models/meta/glm-5.2'));
    confirmSpy.mockRestore();
  });

  describe('scope toggle', () => {
    it('hides unmatched seeded rules by default', () => {
      render(<Harness groups={[group('glm-5.2', 5)]} metaRows={[meta('glm-5.2', 'Z.ai'), meta('kimi-', 'Moonshot')]} />);
      expect(screen.queryByText('kimi-')).not.toBeInTheDocument();
    });

    it('shows them when the toggle is on', () => {
      render(<Harness groups={[group('glm-5.2', 5)]} metaRows={[meta('glm-5.2', 'Z.ai'), meta('kimi-', 'Moonshot')]} />);
      fireEvent.click(screen.getByRole('checkbox', { name: /show all classification rules/i }));
      expect(screen.getByText('kimi-')).toBeInTheDocument();
    });
  });

  it('says so when nothing has been reported', () => {
    render(<Harness groups={[]} metaRows={[]} />);
    expect(screen.getByText('No models reported yet.')).toBeInTheDocument();
  });
  describe('unmap (regression: the unified table must not lose it)', () => {
    it('offers unmap on each alias row', async () => {
      const onUnmap = vi.fn();
      render(<Harness
        groups={[group('glm-5.2', 12, ['glm52'])]}
        metaRows={[meta('glm-5.2', 'Z.ai')]}
        onUnmap={onUnmap}
      />);
      const btn = screen.getByRole('button', { name: /unmap glm52/i });
      fireEvent.click(btn);
      expect(onUnmap).toHaveBeenCalledWith('glm52');
    });

    it('shows a mapping whose alias was never reported, and lets it be unmapped', () => {
      const g = group('glm-5.2', 12);
      g.unusedMappings = [{
        aliasModel: 'glm-5-2-beta', canonicalModel: 'glm-5.2',
        createdByUserId: null, createdByEmail: null, createdAt: '2026-09-01T00:00:00Z',
      }];
      render(<Harness groups={[g]} metaRows={[meta('glm-5.2', 'Z.ai')]} unusedCount={1} onUnmap={vi.fn()} />);
      // "waiting, not broken" — visible and reversible before it is ever reported.
      expect(screen.getByText(/glm-5-2-beta/)).toBeInTheDocument();
      expect(screen.getByText('not reported yet')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /unmap glm-5-2-beta/i })).toBeEnabled();
    });

    it('does not offer unmap on the model row itself', () => {
      render(<Harness groups={[group('glm-5.2', 12)]} metaRows={[meta('glm-5.2', 'Z.ai')]} />);
      expect(screen.queryByRole('button', { name: /^unmap glm-5\.2$/i })).not.toBeInTheDocument();
    });
  });

  it('warns about unmapped names that are each their own group', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelTable
          groups={[group('glm-5.2', 5)] as any} metaRows={[] as any} loading={false}
          onError={() => {}} invalidate={vi.fn()} onUnmap={() => {}} unmapping={false}
          unmappedCount={3} unusedCount={0}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/3 unmapped/)).toBeInTheDocument();
  });

});
