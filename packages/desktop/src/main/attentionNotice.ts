/**
 * The OS banner that says an agent is waiting for you.
 *
 * Decided here rather than in the renderer, for two reasons.
 *
 * **Focus.** The rule is "only when the app is unfocused", and the renderer
 * cannot answer that. `document.hasFocus()` reports whether the DOCUMENT has
 * focus, which is not the same question: a window sitting behind another
 * application can still report a focused document, and a window that was just
 * backgrounded is exactly the case the setting exists for. Only this process
 * can ask the window.
 *
 * **Trust.** A banner is the one part of this feature that renders outside the
 * app's own surface. What goes into it travels from an agent's terminal title,
 * which is agent output — and an OS notification is a good place to put a
 * convincing sentence in front of somebody. So the text is stripped and
 * clipped here, at the border, rather than wherever it came from.
 *
 * Everything is injected so the behaviour can be written down without an
 * Electron binary; `main/index.ts` supplies the real `Notification`.
 */

/** Everything this needs from Electron, and nothing else. */
export interface NoticeDeps {
  /** Whether the app's window is in front. */
  isFocused(): boolean;
  /** Whether this desktop can show a notification at all. */
  supported(): boolean;
  show(options: { title: string; body: string }): void;
}

export interface AttentionNotice {
  /** Which agent stopped, e.g. "Codex". */
  agentLabel: string;
  /** The card it was working on, when there is one a user would recognise. */
  cardTitle?: string;
}

/**
 * How much of a card title a banner can carry.
 *
 * Titles are free text and some of them are a sentence. Every desktop clips
 * silently and none of them say where, so a long title becomes a banner that
 * says nothing at all. Clipping here at least keeps the front of it.
 */
const MAX_TITLE = 80;

/**
 * Newlines, escape introducers, and everything else an agent can put in a title.
 *
 * Built from a raw string rather than written as a regex literal, so the source
 * holds the ESCAPES and not the bytes. A literal containing real control
 * characters is invisible in a diff, changes shape on a copy-paste, and needs an
 * eslint suppression to exist at all.
 */
const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, 'g');

/**
 * Strip what does not belong in a notification, then clip.
 *
 * Control characters first: newlines and escape sequences in a body render as
 * anything from a blank line to what looks like a second, separate message.
 * Angle brackets next, because some notification backends interpret a small
 * amount of markup.
 */
function plain(raw: string, limit: number): string {
  const stripped = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > limit ? `${stripped.slice(0, limit - 1)}…` : stripped;
}

/**
 * Show the banner, or explain by returning false why there was none.
 *
 * Never throws. This is reached from a pty data callback, and an exception
 * escaping here would take down the activity handler that also drives the
 * sessions rail — so a missing notification daemon would cost the user their
 * agent-state display.
 */
export function showAttentionNotice(notice: AttentionNotice, deps: NoticeDeps): boolean {
  try {
    if (!deps.supported()) return false;
    // The card's rule, and the one the user actually asked for: a banner over
    // the window you are typing in steals focus on some desktops and is pure
    // noise on the rest.
    if (deps.isFocused()) return false;

    const agent = plain(notice.agentLabel ?? '', 40) || 'An agent';
    const card = plain(notice.cardTitle ?? '', MAX_TITLE);
    deps.show({
      title: `${agent} is waiting for you`,
      // Says what is being asked of the reader. A banner that only states a
      // fact leaves them to work out whether it needs them.
      body: card
        ? `${card} — it has stopped and needs your attention.`
        : 'It has stopped and needs your attention.',
    });
    return true;
  } catch {
    return false;
  }
}
