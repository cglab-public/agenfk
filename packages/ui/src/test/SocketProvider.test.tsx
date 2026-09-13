/**
 * CGLAB-168: one Socket.io connection per window.
 *
 * Today KanbanBoard, CardDetailModal and RunsPanel each call io() and open
 * their own connection. That is already wasteful with one board on screen; the
 * desktop shell puts a board and N session panes side by side, so the count
 * would grow with every tab the user opens. This provider makes the connection
 * a shared resource and the subscription the per-component thing.
 *
 * The subtle requirement is teardown: a pane closing must remove its own
 * handler and nothing else — not another pane's handler, and above all not the
 * shared connection, which would silently stop live updates everywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import { io } from 'socket.io-client';
import { SocketProvider, useSocketEvent } from '../SocketContext';

/** A fake socket that records handlers so tests can fire events at them. */
function makeFakeSocket() {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    handlers,
    disconnectCalls: 0,
    on(event: string, fn: (...a: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off(event: string, fn: (...a: unknown[]) => void) {
      handlers.get(event)?.delete(fn);
    },
    disconnect() { this.disconnectCalls += 1; },
    emitToClient(event: string, payload?: unknown) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(payload);
    },
    countFor(event: string) { return handlers.get(event)?.size ?? 0; },
  };
}

let fake: ReturnType<typeof makeFakeSocket>;

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

beforeEach(() => {
  fake = makeFakeSocket();
  vi.mocked(io).mockReset();
  vi.mocked(io).mockReturnValue(fake as never);
});

afterEach(() => cleanup());

function Listener({ event, onEvent }: { event: string; onEvent: (p: unknown) => void }) {
  useSocketEvent(event, onEvent);
  return <div />;
}

describe('SocketProvider', () => {
  it('opens exactly one connection no matter how many components subscribe', () => {
    render(
      <SocketProvider>
        <Listener event="items_updated" onEvent={() => {}} />
        <Listener event="run:event" onEvent={() => {}} />
        <Listener event="items_updated" onEvent={() => {}} />
      </SocketProvider>,
    );
    expect(vi.mocked(io)).toHaveBeenCalledTimes(1);
  });

  it('delivers an event to every subscriber of that name', () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <SocketProvider>
        <Listener event="items_updated" onEvent={a} />
        <Listener event="items_updated" onEvent={b} />
      </SocketProvider>,
    );
    act(() => fake.emitToClient('items_updated', { n: 1 }));
    expect(a).toHaveBeenCalledWith({ n: 1 });
    expect(b).toHaveBeenCalledWith({ n: 1 });
  });

  it('does not deliver an event to subscribers of a different name', () => {
    const runs = vi.fn();
    render(
      <SocketProvider>
        <Listener event="run:event" onEvent={runs} />
      </SocketProvider>,
    );
    act(() => fake.emitToClient('items_updated', {}));
    expect(runs).not.toHaveBeenCalled();
  });

  it('removes only the unmounted subscriber, leaving its siblings live', () => {
    const staying = vi.fn();
    const leaving = vi.fn();

    function Pair({ showSecond }: { showSecond: boolean }) {
      return (
        <SocketProvider>
          <Listener event="items_updated" onEvent={staying} />
          {showSecond && <Listener event="items_updated" onEvent={leaving} />}
        </SocketProvider>
      );
    }

    const { rerender } = render(<Pair showSecond />);
    rerender(<Pair showSecond={false} />);

    act(() => fake.emitToClient('items_updated', {}));
    expect(leaving).not.toHaveBeenCalled();
    expect(staying).toHaveBeenCalledTimes(1);
  });

  it('keeps the shared connection open when one subscriber unmounts', () => {
    // The old per-component pattern called socket.disconnect() on unmount.
    // Doing that to a shared socket would kill live updates for every other
    // pane on screen — the failure this whole provider has to avoid.
    function Pair({ showSecond }: { showSecond: boolean }) {
      return (
        <SocketProvider>
          <Listener event="items_updated" onEvent={() => {}} />
          {showSecond && <Listener event="run:event" onEvent={() => {}} />}
        </SocketProvider>
      );
    }
    const { rerender } = render(<Pair showSecond />);
    rerender(<Pair showSecond={false} />);
    expect(fake.disconnectCalls).toBe(0);
  });

  it('disconnects once when the provider itself unmounts', () => {
    const { unmount } = render(
      <SocketProvider>
        <Listener event="items_updated" onEvent={() => {}} />
      </SocketProvider>,
    );
    unmount();
    expect(fake.disconnectCalls).toBe(1);
  });

  it('does not re-subscribe when the handler identity changes on re-render', () => {
    // A handler defined inline in a component body is a new function every
    // render. Re-subscribing on each one would leak listeners until the socket
    // hits its max-listeners warning and events start firing N times.
    function Unstable({ tick }: { tick: number }) {
      useSocketEvent('items_updated', () => { void tick; });
      return <div />;
    }
    const { rerender } = render(
      <SocketProvider><Unstable tick={0} /></SocketProvider>,
    );
    for (let i = 1; i <= 5; i++) {
      rerender(<SocketProvider><Unstable tick={i} /></SocketProvider>);
    }
    expect(fake.countFor('items_updated')).toBe(1);
  });

  it('calls the latest handler, not a stale closure', () => {
    const seen: number[] = [];
    function Counter({ tick }: { tick: number }) {
      useSocketEvent('items_updated', () => seen.push(tick));
      return <div />;
    }
    const { rerender } = render(
      <SocketProvider><Counter tick={1} /></SocketProvider>,
    );
    rerender(<SocketProvider><Counter tick={2} /></SocketProvider>);
    act(() => fake.emitToClient('items_updated'));
    expect(seen).toEqual([2]);
  });

  it('no-ops outside a provider instead of crashing the component', () => {
    // Components are rendered standalone in many existing tests; a hard throw
    // would turn "no live updates" into "blank screen".
    expect(() => render(<Listener event="items_updated" onEvent={() => {}} />)).not.toThrow();
  });
});
