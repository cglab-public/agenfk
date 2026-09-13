/**
 * One Socket.io connection per window (CGLAB-168).
 *
 * Each of KanbanBoard, CardDetailModal and RunsPanel used to call io() and own
 * a connection. That was already three for one board; the desktop shell puts a
 * board and N session panes on screen at once, so the count would grow with
 * every tab. Here the connection is a shared resource and the *subscription*
 * is the per-component thing.
 *
 * Deliberately no-ops when there is no provider above: components are rendered
 * standalone in plenty of tests, and a hard throw would turn "no live updates"
 * into "blank screen".
 */
import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL } from './apiUrl';

const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  // useMemo, not useState: the socket must exist before children run their
  // subscription effects, or the first events after mount are dropped.
  const socket = useMemo(() => io(API_URL || undefined), []);

  useEffect(() => () => { socket.disconnect(); }, [socket]);

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
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return;
    const listener = (payload: T): void => handlerRef.current(payload);
    socket.on(event, listener as never);
    return () => { socket.off(event, listener as never); };
  }, [socket, event]);
}
