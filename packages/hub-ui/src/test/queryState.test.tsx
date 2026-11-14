/**
 * @vitest-environment jsdom
 *
 * QueryState: one answer to "what does a panel show before its data is
 * usable". Loading is a skeleton, not zeros; a failure says what the hub said
 * and offers Retry; an empty answer is its own state.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryState } from '../components/ui';

afterEach(cleanup);

const q = (over: Partial<{ data: number[] | undefined; isError: boolean; error: unknown }> = {}) => ({
  data: undefined as number[] | undefined,
  isError: false,
  error: null as unknown,
  refetch: vi.fn(),
  ...over,
});

describe('QueryState', () => {
  it('shows a labelled skeleton, not the content, while there is no data yet', () => {
    render(<QueryState query={q()} label="events">{d => <p>{d.length} rows</p>}</QueryState>);
    expect(screen.getByRole('status', { name: 'Loading events' })).toBeInTheDocument();
    expect(screen.queryByText(/rows/)).not.toBeInTheDocument();
  });

  it("shows the hub's message and a Retry that refetches when the query failed", () => {
    const query = q({ isError: true, error: { response: { data: { error: 'Database unavailable' } } } });
    render(<QueryState query={query} label="events">{() => <p>content</p>}</QueryState>);
    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('shows the empty state when the answer is empty', () => {
    render(
      <QueryState query={q({ data: [] })} label="events" isEmpty={d => d.length === 0} empty={<p>Nothing here</p>}>
        {() => <p>content</p>}
      </QueryState>,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('renders the content once there is data', () => {
    render(<QueryState query={q({ data: [1, 2] })} label="events">{d => <p>{d.length} rows</p>}</QueryState>);
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps showing data it already has when a refetch fails, with the error above it', () => {
    const query = q({ data: [1], isError: true, error: new Error('timeout') });
    render(<QueryState query={query} label="events">{d => <p>{d.length} rows</p>}</QueryState>);
    expect(screen.getByText('timeout')).toBeInTheDocument();
    expect(screen.getByText('1 rows')).toBeInTheDocument();
  });

  it('says it is retrying, and cannot be clicked again, while the retry is in flight', () => {
    const query = { ...q({ isError: true, error: new Error('timeout') }), isFetching: true };
    render(<QueryState query={query} label="events">{() => null}</QueryState>);
    const button = screen.getByRole('button', { name: 'Retrying…' });
    // Still focusable (a disabled button would drop keyboard focus), but inert.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(query.refetch).not.toHaveBeenCalled();
  });

  it('announces politely unless told the failure is the page\'s main news', () => {
    const failed = q({ isError: true, error: new Error('timeout') });
    const { unmount } = render(<QueryState query={failed} label="a">{() => null}</QueryState>);
    // Two panels failing together must not interrupt twice.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();
    render(<QueryState query={failed} label="a" live="assertive">{() => null}</QueryState>);
    expect(screen.getByRole('alert')).toHaveTextContent('timeout');
  });
});
