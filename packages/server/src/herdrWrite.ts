/**
 * Writing into a herdr pane (96953f6a / CGLAB-266).
 *
 * THIS IS THE HALF THAT TOUCHES SOMEBODY ELSE'S TERMINAL. Everything that
 * reads lives in `herdr.ts`; everything here has a consequence on a screen the
 * person is looking at, so the shape is deliberately narrow: three calls, each
 * one act, and no convenience that merges two of them.
 *
 * THE GRAMMAR IS CHECKED HERE, NOT LEARNED FROM THE SERVER. herdr validates
 * every key and answers `invalid_key`, but a round trip to discover that is
 * worse than a thrown error at the call site — and the refused set is
 * enumerable, so a keypad can grey those keys rather than let someone press
 * something that will always fail. It was enumerated empirically against herdr
 * 0.7.0 and re-verified on 0.7.3 and 0.7.4 (collie's HERDR_API.md, MIT).
 *
 * IT IS NOT TMUX SYNTAX, which is the first thing anyone will try: `C-c` and
 * `BTab` are both refused.
 */
import { encodeRequest, parseResponse, socketTransport, DEFAULT_TIMEOUT_MS,
  type HerdrError, type HerdrTransport } from './herdr.js';

/**
 * The six herdr answers `invalid_key` to, in any spelling and with any modifier.
 *
 * There is no forward-delete and no scrollback paging by key — the mirror
 * scrolls instead. Enumerated so an interface can disable them up front.
 */
export const HERDR_UNSENDABLE_KEYS = ['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete'] as const;

/**
 * Bare, case-insensitive. Exported under a test-shaped name because the
 * relationship between this list and {@link HERDR_UNSENDABLE_KEYS} is the thing
 * worth pinning: none of the six may ever appear here.
 */
export const SPECIAL_KEYS_FOR_TEST = [
  'up', 'down', 'left', 'right', 'tab', 'enter', 'escape', 'space', 'backspace', 'bs',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];

const MODIFIERS = ['ctrl', 'shift', 'alt', 'cmd', 'super', 'meta'];

/** The protocol's request ceiling, minus room for the envelope. */
export const MAX_SEND_TEXT_BYTES = 900 * 1024;

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: HerdrError };

const unsendable = new Set(HERDR_UNSENDABLE_KEYS.map(k => k.toLowerCase()));

/** The base of a chord: everything after the last `+`. */
function baseOf(key: string): string {
  const parts = key.split('+');
  return parts[parts.length - 1] ?? '';
}

/**
 * Whether herdr will accept this key.
 *
 * A single character is itself — that is how a permission dialog gets answered
 * (`["1"]`) and how an option gets picked (`["2", "Enter"]`).
 */
export function isSendableKey(key: string): boolean {
  if (!key) return false;
  const parts = key.split('+');
  if (parts.some(p => p === '')) return false;

  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(m => m.toLowerCase());
  if (mods.some(m => !MODIFIERS.includes(m))) return false;
  if (unsendable.has(base.toLowerCase())) return false;

  // A single character is typed as itself, whatever it is.
  if (base.length === 1) return true;
  return SPECIAL_KEYS_FOR_TEST.includes(base.toLowerCase());
}

/**
 * The spelling that goes on the wire.
 *
 * `meta` becomes `cmd`: the neutral vocabulary has one word for that key and
 * herdr answers to `cmd` and `super`. Both are accepted on input, because a
 * caller that already spells it herdr's way should not be refused for it.
 *
 * A single literal character keeps its case — that IS the character typed.
 */
export function normalizeKey(key: string): string {
  const parts = key.split('+');
  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map(m => (m.toLowerCase() === 'meta' ? 'cmd' : m.toLowerCase()));
  return [...mods, base].join('+');
}

/** One request, one answer, translated into an ack or the server's refusal. */
async function ackOrRefusal(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  transport: HerdrTransport,
  timeoutMs: number,
): Promise<WriteResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let line: string;
  try {
    line = await transport(socketPath, encodeRequest({ id: `agenfk-w-${Date.now()}`, method, params }), controller.signal);
  } catch (err) {
    return controller.signal.aborted
      ? { ok: false, error: { code: 'timeout', message: `herdr did not answer ${method} in ${timeoutMs}ms` } }
      : { ok: false, error: { code: 'unreachable', message: (err as Error).message } };
  } finally {
    clearTimeout(deadline);
  }
  const parsed = parseResponse(line);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

function requirePane(paneId: string): void {
  if (!paneId || !paneId.trim()) {
    throw new TypeError('a pane id is required; herdr would otherwise be asked to guess which terminal to type into');
  }
}

/**
 * Type text into a pane.
 *
 * NO ENTER IS APPENDED, ever. Typing a command into somebody's terminal is one
 * act and running it is another; merging them takes the decision away from the
 * person watching the screen. `agent.send` has the same property on herdr's
 * side and this keeps it.
 */
export async function sendPaneText(
  socketPath: string,
  paneId: string,
  text: string,
  transport: HerdrTransport = socketTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WriteResult> {
  requirePane(paneId);
  if (Buffer.byteLength(text, 'utf8') > MAX_SEND_TEXT_BYTES) {
    throw new RangeError(
      `text is too large for one herdr request (${MAX_SEND_TEXT_BYTES} bytes); over the protocol's `
      + '1 MiB line the server does not answer at all, so this would hang rather than fail',
    );
  }
  return ackOrRefusal(socketPath, 'pane.send_text', { pane_id: paneId, text }, transport, timeoutMs);
}

/**
 * Press keys in a pane.
 *
 * THE WHOLE BATCH IS REFUSED WHEN ONE KEY IS UNSENDABLE. A partial send is
 * worse than none: half a chord arriving in somebody's terminal is input they
 * did not ask for and cannot take back.
 */
export async function sendPaneKeys(
  socketPath: string,
  paneId: string,
  keys: readonly string[],
  transport: HerdrTransport = socketTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WriteResult> {
  requirePane(paneId);
  if (keys.length === 0) {
    throw new RangeError('no keys to send; an empty batch is a request that means nothing');
  }
  const bad = keys.filter(k => !isSendableKey(k));
  if (bad.length > 0) {
    throw new RangeError(
      `herdr refuses these keys: ${bad.join(', ')}. It is not tmux syntax - `
      + `C-c and BTab are rejected - and ${HERDR_UNSENDABLE_KEYS.join(', ')} are refused outright.`,
    );
  }
  return ackOrRefusal(
    socketPath, 'pane.send_keys', { pane_id: paneId, keys: keys.map(normalizeKey) }, transport, timeoutMs,
  );
}

/**
 * Bring a pane to the front — on the operator's real screen.
 *
 * IT MOVES PANE, TAB AND WORKSPACE IN ONE CALL, on the machine the person is
 * working at, right now. It is deliberately its own function with no caller in
 * the write path above: collie reaches for it from exactly one place, the
 * "Show in terminal" row, and it must never be a side effect of typing.
 */
export async function focusPane(
  socketPath: string,
  paneId: string,
  transport: HerdrTransport = socketTransport,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WriteResult> {
  requirePane(paneId);
  return ackOrRefusal(socketPath, 'pane.focus', { pane_id: paneId }, transport, timeoutMs);
}
