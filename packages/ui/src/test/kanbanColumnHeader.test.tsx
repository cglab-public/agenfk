/**
 * @vitest-environment jsdom
 *
 * 85b59d8c — calmer column headers: the step's name on one line in title case
 * (full name on hover), a muted second line that every column has, the check
 * names behind the check count, and the archive button out of the way until
 * the header is hovered or focused.
 */
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { checkText } from '@agenfk/flow-editor';
import { KanbanBoard } from '../components/KanbanBoard';
import { ActiveProjectProvider } from '../ActiveProject';
import { ThemeProvider } from '../ThemeContext';
import { api } from '../api';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
});

const FLOW = {
  id: 'f1', name: 'Gated',
  steps: [
    { id: 'a', name: 'TODO', label: 'To Do', order: 0, isAnchor: true },
    { id: 'b', name: 'SPECS', label: 'QA specs', order: 1, role: 'test-authoring' },
    { id: 'b2', name: 'CI_CD', label: 'CI/CD GATE V2', order: 1.5 },
    { id: 'c', name: 'CODE_REVIEW', label: 'CODE REVIEW', order: 2, checks: [{ id: 'human-approval' }] },
    { id: 'd', name: 'DONE', label: 'Done', order: 3, isAnchor: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(() => Promise.resolve([{ id: 'p1', name: 'P1', createdAt: new Date(), updatedAt: new Date() }])),
    listItems: vi.fn(() => Promise.resolve([])),
    getItem: vi.fn(() => Promise.resolve({})),
    getJiraStatus: vi.fn(() => Promise.resolve({ configured: false, connected: false })),
    getLatestRelease: vi.fn(() => Promise.resolve(null)),
    getVersion: vi.fn(() => Promise.resolve({ version: '1.0.0' })),
    getProjectFlow: vi.fn(),
    getGitHubStatus: vi.fn(() => Promise.resolve({ configured: false })),
    getFlowContract: vi.fn(),
  },
}));

beforeEach(() => {
  localStorage.setItem('agenfk_project_id', 'p1');
  vi.mocked(api.getProjectFlow).mockResolvedValue(FLOW as never);
  vi.mocked(api.getFlowContract).mockImplementation(async (steps: unknown[]) => describeFlowContract(steps));
});
afterEach(() => { cleanup(); localStorage.clear(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={qc}><ActiveProjectProvider><ThemeProvider><KanbanBoard /></ThemeProvider></ActiveProjectProvider></QueryClientProvider>);
}

describe('board column headers', () => {
  it('shows an all-caps label in title case, with the full label on hover', async () => {
    mount();
    const header = await screen.findByTestId('column-header-CODE_REVIEW');
    const title = within(header).getByRole('heading');
    expect(title.textContent).toBe('Code Review');
    expect(title.getAttribute('title')).toBe('CODE REVIEW');
  });

  it('keeps a label the flow already wrote in mixed case, acronyms included', async () => {
    mount();
    const header = await screen.findByTestId('column-header-SPECS');
    expect(within(header).getByRole('heading').textContent).toBe('QA specs');
  });

  it("keeps a word with a '/' or a digit as written", async () => {
    mount();
    const header = await screen.findByTestId('column-header-CI_CD');
    expect(within(header).getByRole('heading').textContent).toBe('CI/CD Gate V2');
  });

  it('gives every column the second line, even one with no role, checks or approval', async () => {
    mount();
    await screen.findByTestId('column-header-SPECS');
    // TODO has nothing to show; the line is there so every header is the same height.
    expect(screen.getByTestId('column-meta-TODO')).toBeTruthy();
    const specsMeta = screen.getByTestId('column-meta-SPECS');
    expect(within(specsMeta).getByText('Writing tests')).toBeTruthy();
  });

  it("names the step's checks behind the check count", async () => {
    mount();
    const header = await screen.findByTestId('column-header-SPECS');
    const contract = describeFlowContract(FLOW.steps).steps.find(s => s.name === 'SPECS')!;
    const blocking = (contract.onLeave ?? contract.checks).filter(c => c.applicable && c.severity === 'block');
    expect(blocking.length).toBeGreaterThan(0);
    const checks = await waitFor(() => within(header).getByTestId('column-checks-SPECS'));
    for (const c of blocking) expect(checks.getAttribute('title')).toContain(checkText(c.id).title);
  });

  it('keeps the archive button out of sight until the header is hovered or focused', async () => {
    mount();
    const header = await screen.findByTestId('column-header-SPECS');
    const archive = within(header).getByTitle('Archive Column');
    expect(header.className).toMatch(/\bgroup\b/);
    expect(archive.className).toMatch(/\bopacity-0\b/);
    expect(archive.className).toMatch(/group-hover:opacity-100/);
    expect(archive.className).toMatch(/focus-visible:opacity-100/);
    // A touch screen has no hover: there it is always shown.
    expect(archive.className).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
    // Still a real button a keyboard reaches, under its name.
    expect(archive.tagName).toBe('BUTTON');
    expect(archive.hasAttribute('disabled')).toBe(false);
    expect(archive.getAttribute('tabindex')).not.toBe('-1');
    archive.focus();
    expect(document.activeElement).toBe(archive);
  });
});
