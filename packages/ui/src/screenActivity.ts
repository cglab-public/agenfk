/**
 * What the agent is doing, read off the rendered screen (CGLAB-193).
 *
 * The OSC title path covers claude-code and codex, which publish a spinner in
 * the terminal title. pi and gemini publish nothing there, so they were left on
 * the old signal — any output at all — which a terminal UI repainting its own
 * footer keeps permanently true.
 *
 * This reads what is ON SCREEN instead. It lives in the renderer, and that is
 * the point rather than an inconsistency with the OSC path living in main: a
 * control sequence is unambiguous in the raw byte stream, but TEXT is not. In
 * the raw stream a partial redraw and a scrolled line are indistinguishable
 * from new content. xterm already resolves all of that into a screen buffer, so
 * the text path reads from the one place where the text is actually true.
 *
 * The rules were learned from herdr's per-agent manifests (Apache-2.0,
 * src/detect/manifests/) — their observations about these TUIs, our table.
 *
 * Screen scraping is fragile and herdr says so by construction: every manifest
 * carries a version and a date, and has a way to ignore transient overlays. The
 * same caution applies here, which is why this matches only the LAST FEW LINES.
 * A "do you want to proceed?" sitting in scrollback from half an hour ago is
 * not a question being asked now.
 */

/** `unknown` means no opinion — never idle. Half the agents publish nothing. */
export type ScreenActivity = 'working' | 'blocked' | 'idle' | 'unknown';

interface ScreenRule {
  readonly state: Exclude<ScreenActivity, 'unknown'>;
  /** Higher wins. Blocked outranks working: a prompt on screen stops the work. */
  readonly priority: number;
  /** Matches if ANY of these appear in the joined tail. */
  readonly contains?: readonly string[];
  /** Matches if ANY of these match a single line of the tail. */
  readonly lineRegex?: readonly RegExp[];
}

/**
 * How many lines from the bottom count as "now".
 *
 * Twelve is what herdr uses for the equivalent regions. Small enough that old
 * scrollback cannot answer for the present, large enough to cover a multi-line
 * confirmation box.
 */
export const TAIL_LINES = 12;

/**
 * Per agent, and dated, for the same reason the title rules are: TUIs change,
 * and a rule that has quietly stopped matching reads as "the agent went idle"
 * rather than as a stale pattern.
 */
export const SCREEN_RULES: Readonly<Record<string, readonly ScreenRule[]>> = {
  pi: [
    // pi's own spinner sits inside a box border it redraws while working.
    { state: 'working', priority: 100, lineRegex: [/^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─+$/u] },
    { state: 'working', priority: 90, contains: ['Working...'] },
  ],
  gemini: [
    // Blocked first: a confirmation box on screen means it is waiting for the
    // person, and gemini keeps printing while it waits.
    {
      state: 'blocked',
      priority: 300,
      contains: ['│ Apply this change', '│ Allow execution', 'do you want to proceed?', 'waiting for user confirmation'],
    },
    { state: 'working', priority: 100, contains: ['esc to cancel'] },
  ],
};

/** When these patterns were last checked against the real TUIs. */
export const SCREEN_RULES_CHECKED = '2026-09-14';

/**
 * Read a state off the last lines of the screen.
 *
 * `unknown` means ONLY "this agent has no rules" — claude-code and codex, which
 * are read from the title instead. An agent that HAS rules and matches none is
 * `idle`, and the difference is the whole reason this function is not the title
 * one:
 *
 *   - a missing TITLE is the agent not publishing. Absence of evidence.
 *   - a missing marker on the CURRENT SCREEN is evidence. pi redraws its
 *     "Working" border while it works and replaces it with the prompt when it
 *     stops, so the border not being there is the agent saying it finished.
 *
 * Carrying the title rule over here was a real defect: pi has only working
 * rules, so `unknown` on no-match meant it could light up and never go dark —
 * precisely the bug this was built to fix.
 */
export function activityFromScreen(agentId: string, tail: readonly string[]): ScreenActivity {
  const rules = SCREEN_RULES[agentId];
  if (!rules) return 'unknown';

  // Only the tail, however much was handed over. A caller that passes the whole
  // buffer must not accidentally let ancient scrollback answer for the present.
  const lines = tail.slice(-TAIL_LINES);
  const joined = lines.join('\n').toLowerCase();

  let best: ScreenRule | null = null;
  for (const rule of rules) {
    if (best && rule.priority <= best.priority) continue;
    const hit =
      rule.contains?.some(needle => joined.includes(needle.toLowerCase()))
      || rule.lineRegex?.some(re => lines.some(line => re.test(line.trimEnd())));
    if (hit) best = rule;
  }
  // No marker on the screen we are looking at right now. For these agents that
  // is the answer, not the absence of one.
  return best?.state ?? 'idle';
}
