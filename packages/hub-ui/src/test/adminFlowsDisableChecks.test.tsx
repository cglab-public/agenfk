/**
 * @vitest-environment jsdom
 *
 * CGLAB-428 — the hub admin is the one host that may switch a step's checks
 * off: Admin → Flows hands the shared editor `canDisableChecks`. The switches
 * themselves are the editor's (flow-editor tests); this pins the wiring, since
 * a flag that never reaches the editor is the same as no flag.
 */
import { render, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminFlows } from '../pages/AdminFlows';
import { api } from '../api';
import { ThemeProvider } from '../ThemeContext';

const seen: Array<Record<string, unknown>> = [];
vi.mock('@agenfk/flow-editor', async (orig) => ({
  ...(await orig() as object),
  FlowEditorModal: (props: Record<string, unknown>) => { seen.push(props); return null; },
}));
vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  seen.length = 0;
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url === '/v1/admin/flows') return { data: [] };
    if (url === '/v1/admin/flow-assignments') return { data: [] };
    return { data: {} };
  });
});
afterEach(() => cleanup());

describe('Admin → Flows lets the hub admin switch checks off', () => {
  it('hands the flow editor canDisableChecks', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ThemeProvider><AdminFlows /></ThemeProvider></QueryClientProvider>);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[seen.length - 1].canDisableChecks).toBe(true);
  });
});
