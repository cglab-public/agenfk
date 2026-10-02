/**
 * @vitest-environment jsdom
 *
 * Disabled controls say why, without hover (TASK 889e5776, story "No
 * hover-only information"). A disabled button is skipped by Tab, so a reason
 * kept in its title reached nobody but a mouse.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TimelineBar } from '../components/TimelineBar';
import { ModelTable } from '../components/ModelTable';
import { ModelMetaFilter } from '../components/ModelMetaFilter';
import type { ModelGroup } from '../pages/modelMappings';
import type { ModelFacetRow } from '../modelMeta';

vi.mock('../api', () => ({ api: { get: vi.fn(async () => ({ data: { bucket: 'hour', buckets: [] } })), put: vi.fn(), delete: vi.fn() } }));

afterEach(cleanup);
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('the timeline in today\'s view', () => {
  it('keeps "day" reachable and says it is hourly today, without switching', async () => {
    render(<QueryClientProvider client={qc()}><TimelineBar range="today" /></QueryClientProvider>);
    const day = await screen.findByRole('button', { name: 'day' });
    // Focusable, so the reason can be reached; marked unavailable instead.
    expect(day).not.toBeDisabled();
    expect(day).toHaveAttribute('aria-disabled', 'true');
    expect(day).toHaveAccessibleDescription('Today view is hourly');

    fireEvent.click(day);

    expect(screen.getByRole('button', { name: 'hour' })).toHaveAttribute('aria-pressed', 'true');
    expect(day).toHaveAttribute('aria-pressed', 'false');
  });

  it('leaves the bucket chosen for longer ranges alone when tapped', async () => {
    // "day" is unavailable today; a tap must not quietly change what the
    // 7-day view comes back to.
    const { rerender } = render(<QueryClientProvider client={qc()}><TimelineBar range="7d" /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'hour' }));
    rerender(<QueryClientProvider client={qc()}><TimelineBar range="today" /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'day' }));
    rerender(<QueryClientProvider client={qc()}><TimelineBar range="7d" /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: 'hour' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is an ordinary button on other ranges', async () => {
    render(<QueryClientProvider client={qc()}><TimelineBar range="7d" /></QueryClientProvider>);
    const day = await screen.findByRole('button', { name: 'day' });
    expect(day).not.toHaveAttribute('aria-disabled');
    expect(day).not.toHaveAccessibleDescription();
  });
});

describe('a model row being edited', () => {
  const group: ModelGroup = {
    canonicalModel: 'glm-5.2', prs: 5,
    aliases: [{ model: 'glm-5.2', prs: 5, canonicalModel: 'glm-5.2', isMapped: false }],
    canonicalSeen: true, unusedMappings: [], createdBy: null,
  };
  const meta = { model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT', source: 'seed' };

  it('says why Save is unavailable, and stops once there is something to save', async () => {
    render(
      <QueryClientProvider client={qc()}>
        <ModelTable groups={[group]} metaRows={[meta] as never} loading={false} onError={() => {}} invalidate={vi.fn()}
          onUnmap={() => {}} unmapping={false} unmappedCount={0} unusedCount={0} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAccessibleDescription('No changes to save');

    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), { target: { value: 'Zhipu AI' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAccessibleDescription());
  });

  it('says on screen what needs fixing, for a sighted keyboard user who cannot reach the title', () => {
    render(
      <QueryClientProvider client={qc()}>
        <ModelTable groups={[group]} metaRows={[meta] as never} loading={false} onError={() => {}} invalidate={vi.fn()}
          onUnmap={() => {}} unmapping={false} unmappedCount={0} unusedCount={0} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /edit classification for glm-5\.2/i }));
    expect(screen.queryByText('Fix the highlighted value first')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), { target: { value: '' } });

    expect(screen.getByText('Fix the highlighted value first')).toBeVisible();
  });
});

describe('model filter chips with nothing left to add', () => {
  const ROWS: ModelFacetRow[] = [
    { model: 'claude-opus-4-8', provider: 'Anthropic', licenseClass: 'commercial', license: 'Proprietary (API only)' },
    { model: 'glm-5.2', provider: 'Z.ai', licenseClass: 'open_weights', license: 'MIT' },
  ];

  it('say so in their name, not only in a title', () => {
    render(<ModelMetaFilter rows={ROWS} selected={new Set(['glm-5.2'])} onApply={vi.fn()} disabled={false} />);
    expect(screen.getByRole('button', { name: /^Z\.ai/ })).toHaveAccessibleName(/all already selected/);
    expect(screen.getByRole('button', { name: /^Anthropic/ })).not.toHaveAccessibleName(/all already selected/);
    expect(screen.getByRole('button', { name: /^open_weights|^Open weights/i })).toHaveAccessibleName(/all already selected/);
  });
});
