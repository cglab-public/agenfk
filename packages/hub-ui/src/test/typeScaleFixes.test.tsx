/**
 * @vitest-environment jsdom
 *
 * Fixes from the type-scale review (story 7073be87): what the codemod got
 * wrong, and the merge rules the new tokens need.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../ThemeContext';
import { cn } from '../components/ui/cn';
import { ConnectPage } from '../pages/Connect';
import { AdminFlows } from '../pages/AdminFlows';
import { PUBLIC_REGISTRY_REPO } from '../pages/adminFlowRegistry';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;

let table: Record<string, unknown> = {};
beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    const hit = Object.keys(table).find(k => url === k || url.startsWith(`${k}?`));
    return { data: hit ? table[hit] : {} };
  });
  table = {};
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);
const mount = (el: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<ThemeProvider><QueryClientProvider client={qc}><MemoryRouter>{el}</MemoryRouter></QueryClientProvider></ThemeProvider>);
};
const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('cn and the new tokens', () => {
  it('lets a caller\'s width win over max-w-data / max-w-form', () => {
    expect(cn('max-w-data space-y-6', 'max-w-[900px]').split(' ')).toEqual(['space-y-6', 'max-w-[900px]']);
    expect(cn('max-w-form', 'max-w-none')).toBe('max-w-none');
  });

  it('keeps a text colour beside a type-scale size, and the later size wins', () => {
    expect(cn('text-navy text-body')).toBe('text-navy text-body');
    expect(cn('text-small', 'text-title')).toBe('text-title');
  });
});

describe('the device-code input', () => {
  it('keeps its wide letter-spacing: it is a field, not an eyebrow', async () => {
    mount(<ConnectPage />);
    const input = await screen.findByPlaceholderText('ABCD-EFGH');
    expect(classes(input)).not.toContain('eyebrow');
    expect(classes(input)).toEqual(expect.arrayContaining(['uppercase', 'tracking-[0.2em]', 'text-title']));
  });
});

describe('flow status pills', () => {
  it('are bold badges, not eyebrows', async () => {
    const steps = [{ id: 's0', name: 'TODO', label: 'To Do', order: 0, isAnchor: true }];
    table = {
      '/v1/admin/flows': [{ id: 'f-1', name: 'Lean', description: '', source: 'hub', version: 1, orgAvailable: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', definition: { name: 'Lean', steps } }],
      '/v1/admin/flows/default': { id: 'default', name: 'Default Flow', steps: [] },
      '/v1/admin/flow-assignments': [],
      '/v1/admin/registry-config': { repo: PUBLIC_REGISTRY_REPO, branch: 'main', isPublic: true, hasToken: false, copiedAt: null },
      '/v1/admin/registry/flows': [], '/v1/admin/child-hubs': { isParent: false, childHubs: [] },
      '/v1/admin/flow-dispatches': { dispatches: [] },
    };
    mount(<AdminFlows />);
    for (const label of [await screen.findByText('Available'), screen.getByText('hub')]) {
      expect(classes(label)).not.toContain('eyebrow');
      expect(classes(label)).toEqual(expect.arrayContaining(['text-caption', 'font-bold', 'uppercase']));
    }
  });
});
