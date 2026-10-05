/**
 * One Socket.io connection per window (CGLAB-168).
 *
 * Each of KanbanBoard, CardDetailModal and RunsPanel used to call io() and own
 * a connection. That was already three for one board; the desktop shell puts a
 * board and N session panes on screen at once, so the count would grow with
 * every tab. Here the connection is a shared resource and the *subscription*
 * is the per-component thing.
 *
 * Connecting is deliberately split from constructing. React StrictMode
 * double-invokes render and runs mount → unmount → mount, so anything built
 * during render is built twice, and the effect cleanup then fires against the
 * instance React kept. With a socket that connects on construction that meant
 * one orphaned live connection plus a `disconnect()` on the socket actually in
 * context — and socket.io sets `skipReconnect` on an explicit disconnect, so it
 * never came back. Every dev session ran with a dead socket: no live board
 * updates at all. Constructing inert and connecting in the effect pairs
 * connect/disconnect 1:1, which is what the old per-component code got right
 * by accident of putting io() inside the effect.
 *
 * Deliberately no-ops when there is no provider above: components are rendered
 * standalone in plenty of tests, and a hard throw would turn "no live updates"
 * into "blank screen".
 */
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './apiUrl';

const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  // Built inert, once per mount. StrictMode double-invokes this initializer,
  // but an unconnected socket is just a discarded object — not the second live
  // connection that autoConnect would have opened.
  const [socket] = useState<Socket>(() => io(API_URL || undefined, { autoConnect: false }));

  useEffect(() => {
    socket.connect();
    return () => { socket.disconnect(); };
  }, [socket]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

/** The shared socket, or null when rendered outside a provider. */
export function useSocket(): Socket | null {
  return useContext(SocketContext);
}

/**
 * Subscribe to one server event for the lifetime of the calling component.
 *
 * The handler is held in a ref and the effect depends only on the event name,
 * so an inline arrow — a new function on every render — subscribes once rather
 * than leaking a listener per render, while still always invoking the latest
 * closure. Cleanup removes this handler alone and never touches the shared
 * connection.
 */
export function useSocketEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): void {
  const socket = useSocket();
  const handlerRef = useRef(handler);

  // After commit, not during render: a render-phase ref write is impure, would
  // record a render React may discard, and the repo's eslint rejects it.
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!socket) return;
    const listener = (payload: T): void => handlerRef.current(payload);
    socket.on(event, listener as never);
    return () => { socket.off(event, listener as never); };
  }, [socket, event]);
}
