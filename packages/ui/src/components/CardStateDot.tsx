/**
 * The one dot on a projects-tree row (CGLAB-164).
 *
 * SHAPE carries the state alongside hue, which is the whole reason this is a
 * component and not three class strings inlined in the row:
 *
 *   working       a filled disc, pulsing, with a soft ring around it
 *   needs-person  a heavy RING, unfilled
 *   quiet         a hairline ring, unfilled
 *
 * Read in greyscale — or by someone who cannot separate amber from grey — the
 * three are still three different marks. Hue alone, in a 7px mark, in a 224px
 * sidebar, would be the entire signal for a reader who cannot use it.
 *
 * What it deliberately CANNOT be told is the card's flow step. That is the
 * decision taken on the card: the shell has a Sessions rail as well as this
 * tree, and two lists repeating one status is worse than one list saying less.
 * The step is rendered as text by the row, to the right.
 */
import React from 'react';
import { clsx } from 'clsx';
import { CARD_STATE_LABEL, type CardState } from '../cardState';

/**
 * The mark itself, per state.
 *
 * `bg-transparent` is spelled out on the two ring states rather than left to
 * the default. It is the assertion the tests make about "filled or not", and a
 * default is not something a reader of this file — or of the row — can see.
 */
const MARK: Record<CardState, string> = {
  working: 'bg-emerald-500 ring-2 ring-emerald-500/20 animate-pulse motion-reduce:animate-none',
  'needs-person': 'border-2 border-amber-500 bg-transparent',
  quiet: 'border border-ink-tertiary/50 bg-transparent',
};

export function CardStateDot({ state }: { state: CardState }): React.ReactElement {
  return (
    // The SLOT is always drawn, even for a quiet card. Rendering nothing took
    // the dot and its gap out of the row, which left a ragged left edge in any
    // list mixing live and quiet cards — and made titles jump sideways and
    // re-truncate on their own when a dot appeared on an event or went out on
    // the TTL, with no user action behind it.
    // mt-[5px] centres a 7px mark on the title's 17px first line — the row is
    // `items-start` because the title and branch stack, so the dot would
    // otherwise sit on the cap line rather than beside the words.
    <span className="mt-[5px] flex items-start">
      <span
        // Kept, because the shell's existing coverage queries it to prove the
        // dot comes on for an event about THIS card and stays off for one about
        // another. Renaming it would delete that coverage silently rather than
        // fail. Only the working state carries it — that is what it has always
        // meant.
        data-testid={state === 'working' ? 'live-dot' : undefined}
        data-card-state={state}
        aria-hidden="true"
        className={clsx('box-border block h-[7px] w-[7px] rounded-full', MARK[state])}
      />
      {/* In the TEXT, not in an aria-label. A label on a non-focusable span
          never reaches assistive tech, and the row's own test reads
          textContent. Quiet says nothing: the absence IS the answer, and a
          sidebar that announces "nothing running" on every row of a
          thirty-card list is noise wearing an accessibility badge. */}
      {state !== 'quiet' && <span className="sr-only">{CARD_STATE_LABEL[state]}</span>}
    </span>
  );
}
