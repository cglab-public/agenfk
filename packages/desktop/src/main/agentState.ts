/**
 * What the agent says it is doing (CGLAB-192).
 *
 * The sessions rail marked a card live on ANY output from its PTY. A terminal
 * UI repaints its own footer — spinner, hint line, cursor — so "running" never
 * went out while the tab existed. Raw output means "the terminal is drawn", not
 * "the agent is working", and measuring burst size cannot save it: an agent
 * that is THINKING is also quiet, which trades a false positive for a false
 * negative.
 *
 * The real signal is published rather than inferred. Claude Code and Codex set
 * the terminal title — an OSC control sequence — and put a spinner glyph in it
 * while they work. That is the agent declaring its own state, and a control
 * sequence cannot be impersonated by output the way a substring can: text
 * containing "Working…" might be a pasted log, but `ESC ]0;` is never content.
 *
 * Learned by reading herdr's per-agent manifests (Apache-2.0,
 * src/detect/manifests/). The glyph ranges below are observations about the
 * agents themselves, checked against those manifests; the rule table is ours.
 *
 * pi and gemini publish NOTHING on OSC — herdr matches their screen text
 * instead. They answer `unknown` here on purpose, and a caller must treat that
 * as "no opinion", never as idle.
 */

/** What the title says. `unknown` means no opinion — never "idle". */
export type AgentActivity = 'working' | 'idle' | 'unknown';

interface TitleRule {
  readonly working?: RegExp;
  readonly idle?: RegExp;
}

/**
 * Per agent, because they differ, and dated because TUIs change.
 *
 * herdr stamps every manifest with a version and a date for exactly this
 * reason, and its Claude rule carries a comment naming the release that moved
 * the spinner. A table that cannot record when it was last true rots silently,
 * and a rotten rule here reads as "the agent stopped working" rather than as a
 * stale pattern.
 */
export const TITLE_RULES: Readonly<Record<string, TitleRule>> = {
  // Braille covers Claude Code up to 2.1.227; the half-circles are the 2.1.228
  // busy spinner. Anchored at the start and followed by a space, because that
  // is where the spinner sits — a Braille character elsewhere in a title is a
  // filename, not a state.
  'claude-code': {
    working: /^[⠀-⣿◐-◓] /u,
    idle: /^✳ /u,
  },
  codex: {
    working: /^[⠀-⣿◐-◓] /u,
  },
  // pi and gemini deliberately absent: they publish no OSC title at all, so a
  // rule here would be a guess. They are the screen-text path, and until that
  // exists they answer `unknown`.
};

/** Last recorded date for the patterns above, so staleness is visible. */
export const TITLE_RULES_CHECKED = '2026-09-14';

/**
 * What a title means for an agent.
 *
 * Returns `unknown` for an agent with no rule AND for a title that matches
 * neither pattern. Those are different situations but the same answer: we do
 * not know. Guessing "idle" would be the confident wrong claim that made the
 * old behaviour useless in the other direction.
 */
export function activityFromTitle(agentId: string, title: string | null): AgentActivity {
  const rule = TITLE_RULES[agentId];
  if (!rule || !title) return 'unknown';
  if (rule.working?.test(title)) return 'working';
  if (rule.idle?.test(title)) return 'idle';
  return 'unknown';
}

/**
 * Bytes we will hold waiting for a terminator before giving up.
 *
 * An unterminated `ESC ]` would otherwise grow the buffer for the life of the
 * session. Titles are short; anything longer is a stream that happens to
 * contain the two bytes, not a sequence.
 */
const MAX_PENDING = 4096;

/**
 * Reads OSC title sequences out of a PTY byte stream.
 *
 * Stateful per session because a sequence can be SPLIT across chunks — the PTY
 * hands over whatever arrived, not whole messages, so `ESC ]0;⣾ wor` and
 * `king\x07` are an ordinary pair of reads.
 */
export class TitleReader {
  private pending = '';
  private title: string | null = null;

  /**
   * Feed a chunk. Returns the current title if it CHANGED, else null.
   *
   * Only on change, deliberately: a TUI rewrites its title on every repaint,
   * and reporting each one would flood the channel with the same value — the
   * very noise this exists to replace.
   */
  push(chunk: string): string | null {
    this.pending += chunk;

    const ESC = '\u001b';
    const BEL = '\u0007';
    const OSC = ESC + ']';
    const ST = ESC + '\\';

    let changed = false;
    for (;;) {
      const start = this.pending.indexOf(OSC);
      if (start < 0) {
        // Nothing pending but possibly a lone ESC at the very end — keep it, so
        // an introducer split across two reads still pairs up.
        this.pending = this.pending.endsWith(ESC) ? ESC : '';
        break;
      }
      // Whatever came before the introducer is ordinary output.
      if (start > 0) this.pending = this.pending.slice(start);

      const bel = this.pending.indexOf(BEL);
      const st = this.pending.indexOf(ST);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        // Unterminated so far. Wait for the rest — unless this has stopped
        // looking like a sequence, in which case holding it forever would leak.
        if (this.pending.length > MAX_PENDING) this.pending = '';
        break;
      }

      const body = this.pending.slice(OSC.length, end);
      this.pending = this.pending.slice(end + (end === st ? ST.length : BEL.length));

      // 0 sets icon name AND title, 2 sets the title. 1 sets only the icon
      // name, which is not where any of these agents put their state.
      const m = /^([0-2]);([\s\S]*)$/.exec(body);
      if (!m || m[1] === '1') continue;
      if (m[2] !== this.title) {
        this.title = m[2];
        changed = true;
      }
    }

    return changed ? this.title : null;
  }

  /** The last title seen, or null if the agent has not set one. */
  current(): string | null {
    return this.title;
  }
}
