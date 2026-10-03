/**
 * @vitest-environment jsdom
 *
 * CGLAB-187: a Mermaid diagram in a project README is untrusted content, and
 * the desktop renderer carries the preload bridge (spawn a shell, write to its
 * pty). Mermaid's `loose` security level skips its own URL sanitization, so a
 * `click X "javascript:..."` directive would survive into the SVG the README
 * modal injects with innerHTML — one click away from a local shell.
 *
 * This pins the security level at the call site, which is the only thing that
 * stops the drift: the diagram helper is otherwise a one-word change nobody
 * looks at again.
 */
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ThemeProvider } from '../ThemeContext';

const MERMAID_IN_README = [
  'Here is the pipeline:',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Click me] --> B[Done]',
  '  click A "javascript:alert(document.domain)"',
  '```',
].join('\n');

vi.mock('../api', () => ({
  api: {
    getReadme: vi.fn(() => Promise.resolve({ content: MERMAID_IN_README })),
  },
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.resolve({ svg: '<svg />' })),
  },
}));

import mermaid from 'mermaid';
import { ReadmeModal } from '../components/ReadmeModal';

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider>
    <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>
  </ThemeProvider>
);

describe('ReadmeModal — Mermaid security (CGLAB-187)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders README diagrams at a URL-sanitizing security level, never "loose"', async () => {
    render(<ReadmeModal isOpen onClose={() => {}} />, { wrapper });

    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());

    const config = vi.mocked(mermaid.initialize).mock.calls[0][0] as { securityLevel?: string };
    expect(config.securityLevel).not.toBe('loose');
    expect(config.securityLevel).toBe('strict');
  });
});