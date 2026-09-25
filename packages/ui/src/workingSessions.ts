/**
 * Who is already working on a card, and which session can show it.
 *
 * TWO QUESTIONS THE SAME ANSWER HAS TO SETTLE. The row's label and the row's
 * press must agree, and when they were computed separately they did not: the
 * label matched a run's conversation against our sessions, while the press
 * looked for a session whose `itemId` was the card. A subagent's session
 * belongs to the PARENT card, so pressing "Open" on the child fell through to
 * a spawn — and the person got a worktree error instead of the terminal that
 * was already on screen.
 *
 * Pure, and here rather than inline in the shell, because that mismatch is
 * only visible when both answers are derived from the same input in one place.
 */

export interface WorkingSession {
  readonly id: string;
  readonly itemId?: string;
  readonly agentSessionId?: string;
  readonly exited?: boolean;
}

export interface WorkingRow {
  readonly itemId?: string;
  readonly state: string;
  readonly hasTerminal?: boolean;
  readonly agentSessionId?: string;
  /** The card's title, for a session that adopts it. */
  readonly title?: string;
}

/** `ours` — this app can take you to it. `elsewhere` — an agent we cannot reach. */
export type Working = 'ours' | 'elsewhere';

/**
 * What is working on each card.
 *
 * A row counts when it is running OR when this app holds a live terminal for
 * it: a terminal sitting at a prompt is still a session you can open, and
 * calling it "nothing" would offer to start a second agent beside it.
 */
export function workingByItem(
  rows: readonly WorkingRow[],
  sessions: readonly WorkingSession[],
): Record<string, Working> {
  const out: Record<string, Working> = {};
  const hosts = new Set(sessions.filter(s => !s.exited).map(s => s.agentSessionId).filter(Boolean));
  for (const row of rows) {
    if (!row.itemId) continue;
    const live = row.state === 'running' || row.hasTerminal === true;
    if (!live) continue;
    const hosted = row.hasTerminal === true
      || (row.agentSessionId ? hosts.has(row.agentSessionId) : false);
    // `ours` wins: one agent we can open beats any number we cannot.
    if (hosted) out[row.itemId] = 'ours';
    else if (!out[row.itemId]) out[row.itemId] = 'elsewhere';
  }
  return out;
}

/**
 * The session that is already showing this card's work, if any.
 *
 * A terminal opened ON the card first; otherwise the one hosting the
 * conversation a run belongs to — which is how a child card opens its parent's
 * session instead of starting a second agent in the same worktree.
 */
export function sessionForItem(
  itemId: string,
  rows: readonly WorkingRow[],
  sessions: readonly WorkingSession[],
): string | null {
  const own = sessions.find(s => s.itemId === itemId && !s.exited);
  if (own) return own.id;
  for (const row of rows) {
    if (row.itemId !== itemId || !row.agentSessionId) continue;
    const host = sessions.find(s => !s.exited && s.agentSessionId === row.agentSessionId);
    if (host) return host.id;
  }
  return null;
}


export interface Adoption {
  readonly sessionId: string;
  readonly itemId: string;
  readonly title?: string;
}

/**
 * A terminal opened on a PROJECT, adopting the card its agent just wrote.
 *
 * The session starts with no card — that is the point of it: the agent runs in
 * the checkout and creates the card itself. What was missing is the other half.
 * Until the session knows which card it produced, the work has no row in the
 * tree, no run to read, and no card to attribute its tokens to.
 *
 * THE LINK IS EXACT, not a guess. The tempting rule — "the first card created
 * after this session opened" — is wrong the moment two agents work in one
 * project, which is the ordinary case here. Instead: when the agent runs the
 * workflow for the card it just made, the hook records a run stamped with the
 * CONVERSATION it belongs to, and that conversation id is the one this
 * terminal was given at spawn. A session adopts the card of the first run
 * naming its own conversation, and only while it has none.
 */
export function adoptions(
  sessions: readonly WorkingSession[],
  rows: readonly WorkingRow[],
): Adoption[] {
  const out: Adoption[] = [];
  for (const session of sessions) {
    // Already has a card, or cannot be matched to one: nothing to adopt.
    if (session.itemId || session.exited || !session.agentSessionId) continue;
    const row = rows.find(r => r.itemId && r.agentSessionId === session.agentSessionId);
    if (row?.itemId) out.push({ sessionId: session.id, itemId: row.itemId, title: row.title });
  }
  return out;
}


export interface RememberedConversation {
  readonly itemId?: string;
  readonly agentId?: string;
  readonly agentSessionId?: string;
}

/**
 * The conversation this card already had with this agent, if any.
 *
 * Reopening a terminal used to start a fresh one: only the app's own RESTORE
 * path carried the remembered id, so closing a tab and opening it again from
 * the card lost everything that had been said. The agents can all resume —
 * claude by directory, pi with the same `--session-id` it was created with —
 * so the only thing missing was handing the id over.
 *
 * Matched on the AGENT as well as the card: two agents can share a card, and
 * resuming one of them inside the other is not "continuing", it is starting a
 * conversation in somebody else's transcript.
 */
export function rememberedConversation(
  itemId: string,
  agentId: string,
  remembered: readonly RememberedConversation[],
): string | null {
  const row = remembered.find(r => r.itemId === itemId && r.agentId === agentId && r.agentSessionId);
  return row?.agentSessionId ?? null;
}
