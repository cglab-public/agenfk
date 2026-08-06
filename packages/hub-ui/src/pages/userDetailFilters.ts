/**
 * Filter defaults for the per-user page.
 *
 * Extracted so the defaults are pinned by test rather than living as literals in
 * the middle of a 300-line component — the previous default was a one-word
 * change away from hiding a person's work again, with nothing to catch it.
 */

/**
 * No event type is filtered out by default.
 *
 * This page used to open with `['item.closed']` — "what did this user ship?".
 * The intent was reasonable and the effect was not: a profile page that shows
 * one of sixteen event types looks, to the person reading it, exactly like a
 * hub that failed to record their work. It was reported three times as a
 * missing-data bug (a commit, then a PR, then a PR again) before anyone noticed
 * the chip was doing it, because nothing on the page says "you are seeing a
 * subset" — the count beside the timeline reports the FILTERED total, which
 * reads as the truth.
 *
 * Empty is also what the other two selectors on this page already default to
 * (`projects`, `itemTypes`), so this makes event types consistent with its
 * neighbours instead of the one special case. Narrowing stays one tap away; the
 * chips are directly above the timeline.
 */
export const DEFAULT_USER_EVENT_TYPES: readonly string[] = [];

/**
 * Versioned deliberately — `:v2` is load-bearing, not decoration.
 *
 * `useToggleSet` persists on mount, not just on change, so every developer who
 * has ever opened this page already has `["item.closed"]` written under the v1
 * key. `readPersistedSet` honours a stored value whenever the key exists (an
 * explicitly-emptied set must round-trip as empty, which is correct), so a
 * stored v1 selection would outrank the new default forever and the fix would
 * ship without changing anything for the people who hit the problem.
 *
 * Bumping the key retires those writes once. The cost is that a genuinely
 * intentional v1 selection is forgotten on first load after upgrade — which is
 * the right trade against silently hiding the page's contents.
 */
export const USER_EVENT_TYPES_STORAGE_KEY = 'agenfk-hub:user:eventTypes:v2';
export const USER_PROJECTS_STORAGE_KEY = 'agenfk-hub:user:projects';
export const USER_ITEM_TYPES_STORAGE_KEY = 'agenfk-hub:user:itemTypes';
