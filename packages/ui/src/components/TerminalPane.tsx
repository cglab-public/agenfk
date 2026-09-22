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
import { activityFromScreen, SCREEN_RULES, TAIL_LINES, type ScreenActivity } from '../screenActivity';
import { Terminal as XTerm, type ITerminalAddon, type Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_OPTIONS } from '../terminalOptions';
import type { ITerminalOptions } from '@xterm/xterm';

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
  /**
   * Report how much of what was sent has been drawn.
   *
   * Optional, like `onActivity`, because an older preload will not have it —
   * and a pane that threw here would be a blank terminal, which is a far worse
   * outcome than no backpressure.
   */
  ack?(sessionId: string, bytes: number): Promise<boolean>;
  /**
   * One session's output. Session-scoped, because the preload routes by
   * session now: one ipcRenderer listener per channel rather than one per
   * pane. See sessionDemux.ts for what that cost.
   */
  onData(sessionId: string, cb: (e: { sessionId: string; data: string }) => void): () => void;
  onExit(sessionId: string, cb: (e: { sessionId: string; exitCode: number }) => void): () => void;
  /** The agent published its own state via the terminal title. Optional: an
   *  older preload does not have it, and the pane must still work. */
  onActivity?(sessionId: string, cb: (e: { sessionId: string; activity: 'working' | 'blocked' | 'idle' }) => void): () => void;
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
  /**
   * The process ended.
   *
   * The pane knew this and kept it to itself — `exitCode` was local state used
   * only to draw a line. The shell needs it too: the sessions rail was still
   * calling an exited session "running", because the only thing it had to go
   * on was recency of OUTPUT, and the exit message is itself output.
   */
  readonly onExited?: (exitCode: number) => void;
  /**
   * The agent said what it is doing.
   *
   * Reported upward rather than kept here for the same reason `onExited` is:
   * the sessions rail needs it, and the pane is the only place the stream
   * arrives.
   */
  readonly onActivity?: (activity: 'working' | 'blocked' | 'idle') => void;
  /**
   * The state read off the rendered screen, for agents that publish no title.
   *
   * Separate from `onActivity` because the sources are not equivalent: the
   * title is the agent's own word, the screen is our reading of its drawing.
   * Keeping them apart means a future disagreement is visible rather than
   * silently resolved by whichever fired last.
   */
  readonly onScreenActivity?: (activity: Exclude<ScreenActivity, 'unknown'>) => void;
  /**
   * Builds the terminal. Receives the options the real path would use, so a
   * test can assert on them — see TerminalPane.test.ts.
   */
  readonly createTerminal?: (options: ITerminalOptions) => Terminal;
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
  onExited,
  onActivity,
  onScreenActivity,
  createTerminal,
  createFitAddon,
  bridge,
}: TerminalPaneProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exitCode, setExitCode] = React.useState<number | null>(null);
  /** Last state read off the screen, so an unchanged one is not re-reported. */
  const lastScreen = React.useRef<ScreenActivity | null>(null);
  /*
   * Through a ref, not the closure. The data handler is registered once and
   * outlives the render that made it; closing over `agentId` would pin the
   * value from that first render, which is the same class of bug as reading
   * state inside an updater.
   */
  const agentIdRef = React.useRef(agentId);
  agentIdRef.current = agentId;
  /** Pending trailing scan, so the frame that says "finished" is never lost. */
  const trailingScan = React.useRef<number | undefined>(undefined);

  // Everything the cleanup needs, held in refs rather than state: the teardown
  // must run with whatever exists at that moment, and a state update would be
  // a render that never happens on an unmounting component.
  // Last time output was reported upward, for the throttle above.
  const lastReport = React.useRef(0);
  /** Drawn bytes not yet reported to main, and whether a flush is scheduled. */
  const pendingAck = React.useRef(0);
  const ackQueued = React.useRef(false);
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
    /*
     * Subscriptions wait for the session id.
     *
     * The preload routes terminal events BY SESSION now — one ipcRenderer
     * listener per channel rather than one per pane, because a broadcast
     * subscription meant every chunk was dispatched to every open terminal and
     * discarded by all but one. Routing needs the id, and the id only exists
     * once the spawn resolves.
     *
     * Nothing that used to arrive is lost by waiting: the filter these
     * callbacks still carry already discarded everything that reached them
     * before `sessionRef` was set. Buffering that window properly is its own
     * card (bb70a417).
     */
    const pending: Array<(sessionId: string) => () => void> = [];

    /*
     * The options are passed THROUGH the seam, not captured behind it.
     *
     * The factory used to take no arguments, so an injected one never saw what
     * the real path builds — and reverting this line to an inline options
     * object left all 986 UI tests green. A seam that hides the thing it
     * exists to let you observe is not a seam.
     */
    const term = (createTerminal ?? (opts => new XTerm(opts)))(TERMINAL_OPTIONS);
    termRef.current = term;

    const fit = (createFitAddon ?? (() => new FitAddon() as FitLike))();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* no layout under jsdom */ }

    // Subscribe BEFORE spawning: output can arrive between the session being
    // created in the main process and the promise resolving here, and a
    // terminal that silently drops its first lines looks like it hung.
    /** Read the visible tail and report a change. */
    const scanScreen = (): void => {
      if (!onScreenActivity) return;
      const buf = term.buffer.active;
      const bottom = buf.baseY + buf.cursorY;
      const tail: string[] = [];
      for (let i = Math.max(0, bottom - TAIL_LINES); i <= bottom; i += 1) {
        tail.push(buf.getLine(i)?.translateToString(true) ?? '');
      }
      const seen = activityFromScreen(agentIdRef.current, tail);
      // `unknown` only ever means "no rules for this agent" now, so it is the
      // one answer that must not overwrite anything.
      if (seen === 'unknown' || seen === lastScreen.current) return;
      lastScreen.current = seen;
      onScreenActivity(seen);
    };

    pending.push(id => api.onData(id, ({ sessionId, data }) => {
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
      const reportedNow = now - lastReport.current > OUTPUT_REPORT_MS;
      if (reportedNow) {
        lastReport.current = now;
        onOutput?.();
      }
      /*
       * The callback is the whole point, and it was always available and never
       * used. xterm calls it once this chunk has actually been PARSED, which
       * is the only honest measure of whether the terminal is keeping up —
       * `write` returning simply means the bytes were queued, and the queue is
       * exactly what was growing to 50 MB.
       *
       * Coalesced rather than sent per chunk: output arrives in thousands of
       * small reads, and one IPC round trip each would cost more than the
       * problem. Bytes accumulate and are flushed on a microtask, so a burst
       * of a thousand chunks becomes one message carrying their sum.
       */
      term.write(data, () => {
        pendingAck.current += data.length;
        if (ackQueued.current) return;
        ackQueued.current = true;
        queueMicrotask(() => {
          ackQueued.current = false;
          const bytes = pendingAck.current;
          pendingAck.current = 0;
          const id = sessionRef.current;
          // Nothing to say, or the session is already gone. Main forgives an
          // ack for a session it no longer has, but there is no reason to send
          // one.
          if (!bytes || !id) return;
          void api.ack?.(id, bytes);
        });
      });

      /*
       * Read the state off the RENDERED screen, for agents that publish
       * nothing in the terminal title (CGLAB-193).
       *
       * After the write, deliberately: the buffer has to hold what the user
       * can see. And on the same throttle as the liveness report above,
       * because a repainting footer produces many small chunks and scanning
       * the tail on each one would be the cost this throttle exists to avoid.
       *
       * Read from xterm rather than from `data` because in the raw stream a
       * partial redraw and a scrolled line are indistinguishable from new
       * content. The buffer is the one place the text is actually true.
       */
      if (onScreenActivity && SCREEN_RULES[agentIdRef.current]) {
        if (reportedNow) scanScreen();
        /*
         * And once more shortly after the output stops.
         *
         * The frame that says an agent FINISHED is its last one — pi replaces
         * the Working border with the prompt and then goes quiet. If that
         * redraw lands inside the throttle window it is skipped, no further
         * output ever arrives to trigger a rescan, and the row stays lit
         * forever: the same bug, reached by a different route.
         */
        window.clearTimeout(trailingScan.current);
        trailingScan.current = window.setTimeout(scanScreen, OUTPUT_REPORT_MS);
      }
    }));

    // Optional on the bridge: an older preload has no such channel, and a
    // missing signal must degrade to "no opinion", never to a crash.
    if (api.onActivity) {
      pending.push(id => api.onActivity!(id, ({ sessionId, activity }) => {
        if (sessionId !== sessionRef.current) return;
        onActivity?.(activity);
      }));
    }

    pending.push(id => api.onExit(id, ({ sessionId, exitCode: code }) => {
      if (sessionId !== sessionRef.current) return;
      // Said out loud: without it the terminal simply stops responding, which
      // is indistinguishable from a hang.
      setExitCode(code);
      // And told upwards. A session whose process is gone must stop counting
      // as running immediately — that is a fact, not something to age out of
      // a liveness window.
      onExited?.(code);
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
        /*
         * THE SIZE, NOW THAT THERE IS SOMEBODY TO TELL.
         *
         * The pty is spawned with whatever `fit()` could measure before the
         * pane had been laid out — often the 80×24 fallback. The correct
         * measurement DID arrive: ResizeObserver fires as soon as it observes.
         * But that is before this promise resolves, and `applyResize` drops
         * the call when there is no session yet — so the right number was
         * computed and thrown away, and nothing measured again until somebody
         * dragged a split.
         *
         * What that looks like: the agent draws into a terminal of 24 rows
         * while the view shows fifty. Claude Code anchors its input box to the
         * bottom of the terminal IT believes it has, so the box lands in the
         * middle of the pane with a black rectangle underneath — and the
         * person reports, correctly, that they cannot see where to type.
         */
        applyResize();
        // Now that the session has a name, start listening for its events.
        for (const subscribe of pending) cleanups.push(subscribe(result.sessionId));
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
      // Before anything else: a trailing scan that fires after teardown would
      // read a disposed terminal and report state for a tab that is gone.
      window.clearTimeout(trailingScan.current);
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
