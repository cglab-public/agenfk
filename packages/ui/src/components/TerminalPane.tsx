/**
 * A terminal for one card, in that card's worktree (CGLAB-169).
 *
 * The renderer's whole job here is lifecycle. It names an item and an agent;
 * the main process decides the directory and the command. Nothing in this file
 * may grow the ability to say *what* runs — that is the border the preload
 * surface draws, and it only holds while this side stays incurious.
 *
 * xterm and the fit addon can be INJECTED, and the tests do inject them: they
 * do not run meaningfully under jsdom, and the defects worth catching are not
 * "does xterm draw" but the reaping — a closed tab that leaves a shell attached
 * to a worktree, or a listener still writing into a component that no longer
 * exists. The real ones are imported statically; an earlier version claimed to
 * load them lazily to keep a browser build lean, which was not true and could
 * not be, since `require` does not exist in that bundle.
 */
import React from 'react';
import { Terminal as XTerm, type ITerminalAddon, type Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** The slice of the preload surface this component uses. */
export interface TerminalBridge {
  spawn(req: {
    itemId: string; agentId: string; cols: number; rows: number;
    autoApprove?: boolean; persist?: boolean;
    agentSessionId?: string; resume?: boolean;
  }): Promise<{ sessionId: string; agentSessionId?: string }>;
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
  /** Run the agent with its own permission prompts disabled. */
  readonly autoApprove?: boolean;
  /**
   * Whether this session runs inside tmux.
   *
   * A resolved decision from Settings, combined with the machine's capability
   * in the main process — this component neither re-derives it nor checks it.
   */
  readonly persist?: boolean;
  /** The conversation to resume. Absent on a fresh terminal; main mints one. */
  readonly agentSessionId?: string;
  readonly resume?: boolean;
  /**
   * The conversation id the agent actually got.
   *
   * Reported upward because the SHELL is what stores it, and it is only known
   * once the spawn answers. Absent for agents that cannot be told their own id.
   */
  readonly onSpawned?: (agentSessionId: string | undefined) => void;
  /**
   * The terminal produced output.
   *
   * Throttled, and reported as a bare fact rather than the bytes: the shell
   * only needs to know that something happened, and passing the content would
   * put terminal output through a component that has no business reading it.
   */
  readonly onOutput?: () => void;
  readonly createTerminal?: () => Terminal;
  readonly createFitAddon?: () => FitLike;
  readonly bridge?: TerminalBridge;
}

const defaultBridge = (): TerminalBridge | null =>
  (window as unknown as { agenfkDesktop?: { terminal?: TerminalBridge } }).agenfkDesktop?.terminal ?? null;

/** At most one liveness report per this many ms, however fast output arrives. */
const OUTPUT_REPORT_MS = 2000;

export function TerminalPane({
  itemId,
  agentId,
  autoApprove,
  persist,
  agentSessionId,
  resume,
  onSpawned,
  onOutput,
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
  // Last time output was reported upward, for the throttle above.
  const lastReport = React.useRef(0);
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

    const term = (createTerminal ?? (() =>
      new XTerm({ convertEol: true, fontSize: 12, cursorBlink: true })))();
    termRef.current = term;

    const fit = (createFitAddon ?? (() => new FitAddon() as FitLike))();
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
      // Reported BEFORE drawing. The fact being reported is that bytes
      // arrived, which is true whether or not this renderer can paint them —
      // and a write that throws must not also swallow the liveness signal.
      //
      // Throttled hard: output arrives in many small chunks, and every report
      // wakes the shell to recompute the rail, which is the cost the rail's
      // one-timer design exists to avoid.
      const now = Date.now();
      if (now - lastReport.current > OUTPUT_REPORT_MS) {
        lastReport.current = now;
        onOutput?.();
      }
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

    const applyResize = (): void => {
      try { fit.fit(); } catch { /* no layout under jsdom */ }
      const session = sessionRef.current;
      if (session) void api.resize(session, term.cols, term.rows);
    };

    // Leading edge fires at once; the trailing one catches the end of a drag.
    // Trailing-only would leave the child drawing against stale dimensions for
    // the whole drag, and that overlapping output is baked permanently into the
    // scrollback — a later correct resize cannot repair it.
    let trailing: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    const DEBOUNCE_MS = 60;
    const onGeometryChange = (): void => {
      const now = Date.now();
      if (now - lastRun >= DEBOUNCE_MS) {
        lastRun = now;
        applyResize();
      }
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = null;
        lastRun = Date.now();
        applyResize();
      }, DEBOUNCE_MS);
    };

    // The PANE, not the window. Dragging a split or collapsing the sidebar
    // changes this element without changing the window, so a window listener
    // sees nothing. It also fires when the element becomes visible again after
    // the tab was hidden — where `fit()` is a no-op, because a display:none
    // ancestor gives it a computed width of `auto`, hence NaN, hence a bail.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onGeometryChange) : null;
    observer?.observe(host);
    cleanups.push(() => {
      if (trailing) clearTimeout(trailing);
      observer?.disconnect();
    });

    // The renderer sends an item and an agent, never a path and never a
    // command. Keep it that way.
    api.spawn({
      itemId, agentId,
      autoApprove: autoApprove === true,
      persist: persist === true,
      // Only when there is one AND we mean to resume it. Asking to resume
      // nothing either fails the launch or picks somebody else's session.
      ...(resume && agentSessionId ? { agentSessionId, resume: true } : {}),
      cols: term.cols || 80, rows: term.rows || 24,
    })
      .then(result => {
        if (cancelled) {
          // The effect was torn down while the spawn was in flight. The main
          // process has a live shell now and nobody is holding it.
          void api.kill(result.sessionId);
          return;
        }
        sessionRef.current = result.sessionId;
        // After the handle is stored, so a throw in the shell's bookkeeping
        // cannot leave a live process nobody can kill.
        onSpawned?.(result.agentSessionId);
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
    // onSpawned is deliberately NOT a dependency: it is a reporting channel,
    // and an unstable identity would tear the terminal down and start a second
    // agent in the same worktree.
  }, [itemId, agentId, autoApprove, persist, agentSessionId, resume, bridge, createTerminal, createFitAddon]);

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
