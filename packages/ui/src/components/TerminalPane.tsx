/**
 * A terminal for one card, in that card's worktree (CGLAB-169).
 *
 * The renderer's whole job here is lifecycle. It names an item and an agent;
 * the main process decides the directory and the command. Nothing in this file
 * may grow the ability to say *what* runs — that is the border the preload
 * surface draws, and it only holds while this side stays incurious.
 *
 * xterm and the fit addon are injected rather than imported directly so the
 * lifecycle can be tested. They do not run meaningfully under jsdom, and the
 * defects worth catching are not "does xterm draw" but the reaping: a closed
 * tab that leaves a shell attached to a worktree, or a listener still writing
 * into a component that no longer exists.
 */
import React from 'react';
import type { ITerminalAddon, Terminal } from '@xterm/xterm';

/** The slice of the preload surface this component uses. */
export interface TerminalBridge {
  spawn(req: { itemId: string; agentId: string; cols: number; rows: number }): Promise<string>;
  write(sessionId: string, data: string): Promise<boolean>;
  resize(sessionId: string, cols: number, rows: number): Promise<boolean>;
  kill(sessionId: string): Promise<boolean>;
  onData(cb: (e: { sessionId: string; data: string }) => void): () => void;
  onExit(cb: (e: { sessionId: string; exitCode: number }) => void): () => void;
}

interface FitLike extends ITerminalAddon {
  fit(): void;
}

export interface TerminalPaneProps {
  readonly itemId: string;
  readonly agentId: string;
  readonly createTerminal?: () => Terminal;
  readonly createFitAddon?: () => FitLike;
  readonly bridge?: TerminalBridge;
}

const defaultBridge = (): TerminalBridge | null =>
  (window as unknown as { agenfkDesktop?: { terminal?: TerminalBridge } }).agenfkDesktop?.terminal ?? null;

export function TerminalPane({
  itemId,
  agentId,
  createTerminal,
  createFitAddon,
  bridge,
}: TerminalPaneProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);

  // Everything the cleanup needs, held in refs rather than state: the teardown
  // must run with whatever exists at that moment, and a state update would be
  // a render that never happens on an unmounting component.
  const sessionRef = React.useRef<string | null>(null);
  const termRef = React.useRef<Terminal | null>(null);

  React.useEffect(() => {
    const host = hostRef.current;
    const api = bridge ?? defaultBridge();
    if (!host || !api) {
      setError('Terminals are only available in the desktop app.');
      return;
    }

    // StrictMode mounts, unmounts and remounts effects in development. Without
    // this, the discarded first mount still resolves its spawn and leaves an
    // orphaned shell attached to the worktree on every reload.
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const term = (createTerminal ?? (() => {
      // Imported lazily: xterm touches the DOM at module scope and there is no
      // reason for a browser-only build to carry it.
      const { Terminal: XTerm } = require('@xterm/xterm') as typeof import('@xterm/xterm');
      return new XTerm({ convertEol: true, fontSize: 12, cursorBlink: true });
    }))();
    termRef.current = term;

    const fit = (createFitAddon ?? (() => {
      const { FitAddon } = require('@xterm/addon-fit') as typeof import('@xterm/addon-fit');
      return new FitAddon() as FitLike;
    }))();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* no layout under jsdom */ }

    // Subscribe BEFORE spawning: output can arrive between the session being
    // created in the main process and the promise resolving here, and a
    // terminal that silently drops its first lines looks like it hung.
    cleanups.push(api.onData(({ sessionId, data }) => {
      // Every open terminal listens on this one channel, so the filter is what
      // keeps one card's output out of every other card's tab.
      if (sessionId !== sessionRef.current) return;
      term.write(data);
    }));

    cleanups.push(api.onExit(({ sessionId, exitCode: code }) => {
      if (sessionId !== sessionRef.current) return;
      // Said out loud: without it the terminal simply stops responding, which
      // is indistinguishable from a hang.
      setExitCode(code);
    }));

    const input = term.onData(data => {
      const session = sessionRef.current;
      if (session) void api.write(session, data);
    });
    cleanups.push(() => input.dispose());

    const onResize = (): void => {
      try { fit.fit(); } catch { /* no layout under jsdom */ }
      const session = sessionRef.current;
      if (session) void api.resize(session, term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));

    // The renderer sends an item and an agent, never a path and never a
    // command. Keep it that way.
    api.spawn({ itemId, agentId, cols: term.cols || 80, rows: term.rows || 24 })
      .then(sessionId => {
        if (cancelled) {
          // The effect was torn down while the spawn was in flight. The main
          // process has a live shell now and nobody is holding it.
          void api.kill(sessionId);
          return;
        }
        sessionRef.current = sessionId;
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // resolveWorktree throws rather than falling back, and its message
        // names what to fix. Swallowing it leaves a black rectangle.
        setError(e.message);
      });

    return () => {
      cancelled = true;
      for (const off of cleanups) off();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void api.kill(session);
      // xterm attaches its own listeners and observers; dropping the DOM node
      // is not enough.
      term.dispose();
      termRef.current = null;
    };
  }, [itemId, agentId, bridge, createTerminal, createFitAddon]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#14181b]">
      {error && (
        <div role="alert" className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}
      {exitCode !== null && (
        <div className="border-b border-border-soft bg-canvas px-3 py-2 text-xs text-ink-tertiary">
          Session exited ({exitCode}).
        </div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1" data-testid="terminal-host" />
    </div>
  );
}
