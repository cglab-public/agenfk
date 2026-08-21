// Decision logic for the Admin → Identities tab (task f78c0849).
//
// A merge rewrites history, so this module's job is to be conservative about
// which suggestions are offered as a single action. The hub derives candidates
// from immutable installation provenance, but historical keys predate the osUser
// namespacing — so a source key like 'dev', 'ubuntu' or 'runner' can still be
// several people at once. Merges are revertible, but a revert an admin never
// realises they need is no protection.
//
// `blockedByLiveKey` means an installation reports this key TODAY and is still
// ingesting; a machine dormant past the hub's liveness window does not block,
// because the merge records an alias that stops it resurrecting the key.
// (CGLAB-72.)

export type Confidence = 'unambiguous' | 'conflated';

export interface SuggestionLike {
  from: string;
  to: string;
  events: number;
  firstSeen: string;
  lastSeen: string;
  installations: string[];
  sourceInstallationCount: number;
  targetCandidateCount: number;
  confidence: Confidence;
  blockedByLiveKey: boolean;
  /** Installations that still report `from`; present when blockedByLiveKey. */
  blockingInstallations?: string[];
}

/**
 * Only an unambiguous, unblocked candidate gets a button. Everything else needs
 * a human to look at the breakdown first — attributing one person's history to
 * another is not recoverable.
 */
export function canMergeInOneClick(sug: SuggestionLike): boolean {
  return sug.confidence === 'unambiguous' && !sug.blockedByLiveKey;
}

/**
 * Why the button is disabled, phrased as the risk rather than the rule. The live
 * key comes first because the server enforces that one with a 409 — a user who
 * clears conflation but leaves the key would still be refused.
 */
export function mergeBlockedReason(sug: SuggestionLike): string | null {
  if (sug.blockedByLiveKey) {
    const n = sug.blockingInstallations?.length ?? 0;
    const many = n > 1;
    return (
      `${many ? `${n} active installations still report` : 'An active installation still reports'} ` +
      `"${sug.from}" and ${many ? 'hold live API keys' : 'holds a live API key'}, so new events would ` +
      `keep arriving under it after the merge. Retire ${many ? 'those installations' : 'that installation'}, ` +
      `or revoke ${many ? 'their keys' : 'its key'}, first.`
    );
  }
  if (sug.confidence === 'conflated') {
    return (
      `"${sug.from}" was produced by ${sug.sourceInstallationCount} installations, so it may be ` +
      `more than one person — merging it could file someone else's work under this identity, ` +
      `and there is no way to undo that. Review the installations below.`
    );
  }
  return null;
}

/** Actionable first, then biggest attribution error first. */
export function sortSuggestions<T extends SuggestionLike>(rows: T[]): T[] {
  const rank = (r: SuggestionLike) => (r.blockedByLiveKey ? 2 : r.confidence === 'conflated' ? 1 : 0);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.events - a.events);
}

export interface SuggestionSummary {
  total: number;
  ready: number;
  conflated: number;
  blocked: number;
}

/**
 * Counts for the header. `conflated` and `blocked` overlap deliberately — they
 * are two independent reasons a row needs attention, and hiding one behind the
 * other would understate the work.
 */
export function suggestionSummary(rows: SuggestionLike[]): SuggestionSummary {
  return {
    total: rows.length,
    ready: rows.filter(canMergeInOneClick).length,
    conflated: rows.filter(r => r.confidence === 'conflated').length,
    blocked: rows.filter(r => r.blockedByLiveKey).length,
  };
}

/** Mirrors the server's validation, so the form cannot submit a certain 400. */
export function isValidManualMerge(from: string, to: string): boolean {
  const a = from.trim();
  const b = to.trim();
  if (!a || !b) return false;
  return a.toLowerCase() !== b.toLowerCase();
}
