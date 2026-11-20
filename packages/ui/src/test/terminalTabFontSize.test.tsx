/**
 * @vitest-environment jsdom
 *
 * INFRA-425: the stored terminal font size reaches every pane.
 *
 * The pane itself is replaced here so the test can read the props it was
 * given; appearancePrefs.test.tsx covers what the real pane does with them.
 */
import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const paneProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../components/TerminalPane', () => ({
  TerminalPane: (props: Record<string, unknown>) => { paneProps.push(props); return null; },
}));
vi.mock('../api', () => ({ api: { getGitStatus: vi.fn(async () => ({ changed: 0, staged: 0, files: [] })) } }));

import { TerminalTab } from '../components/TerminalTab';

afterEach(() => { cleanup(); paneProps.length = 0; });

const props = () => ({
  sessions: [{
    id: 's1', itemId: 'i1', title: 'A card', agentId: 'shell',
    autoApprove: false, persist: false, openedAt: new Date().toISOString(),
  }],
  activeId: 's1',
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNew: vi.fn(),
});

const renderTab = (ui: React.ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);

describe('the terminal font size', () => {
  it('is handed to the pane', () => {
    renderTab(<TerminalTab {...props()} terminalFontSize={18} />);
    expect(paneProps.at(-1)?.fontSize).toBe(18);
  });

  it('is left to the pane default when nobody has chosen one', () => {
    renderTab(<TerminalTab {...props()} />);
    expect(paneProps.at(-1)?.fontSize).toBeUndefined();
  });
});
