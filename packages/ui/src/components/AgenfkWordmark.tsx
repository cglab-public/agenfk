/**
 * The product's name, drawn rather than typeset.
 *
 * The first version of this set "AgEnFK" as CSS text in the UI font, and it
 * was wrong in the way a substitute always is: the real face carries a stroke
 * through the K that no system font has, and the capitalisation is agenFK -
 * lowercase agen against uppercase FK - which is what gives the word its shape.
 * So this renders the brand book's own outlines, the same way AgenfkFlag does.
 *
 * FK CARRIES THE BRAND COLOUR. The book draws the word in one colour; showing
 * the second half in the accent is a decision taken here, which is why the
 * split has to be measured rather than assumed. See WORD_SPLIT_X.
 *
 * Drawn as two clipped copies of one path rather than as two paths, because
 * the outlines are a single shape with fill-rule evenodd - splitting the data
 * itself would break the counters in a, g and e.
 */
import React from 'react';
import { WORD_ASPECT, WORD_PATH, WORD_SPLIT_X, WORD_VIEWBOX } from './agenfkWordPath';

export interface AgenfkWordmarkProps {
  /** Rendered height in px. Width follows from the book's own proportions. */
  size?: number;
  className?: string;
}

/**
 * Unique per instance. Two wordmarks on one page sharing a clip id would both
 * resolve to whichever was defined first, and one of them would lose its FK.
 */
let seq = 0;

export function AgenfkWordmark({ size = 13, className = '' }: AgenfkWordmarkProps) {
  const id = React.useMemo(() => `agenfk-word-${(seq += 1)}`, []);
  return (
    <svg
      viewBox={WORD_VIEWBOX}
      width={Math.round(size * WORD_ASPECT)}
      height={size}
      role="img"
      aria-label="agenFK"
      /*
       * `text-ink` so `agen` follows the theme through currentColor: the token
       * resolves to near-black on light and near-white on dark. An earlier
       * version filled it with var(--ink), which is not a token that exists -
       * the Tailwind colour `ink` maps to --color-ink, which maps to
       * --text-primary - so it resolved to nothing and fell back to black,
       * leaving the name unreadable on the dark ground the app ships with.
       */
      className={`text-ink ${className}`.trim()}
    >
      <title>agenFK</title>
      <defs>
        <clipPath id={`${id}-a`}>
          <rect x="0" y="-20" width={WORD_SPLIT_X} height="240" />
        </clipPath>
        <clipPath id={`${id}-b`}>
          <rect x={WORD_SPLIT_X} y="-20" width="600" height="240" />
        </clipPath>
      </defs>
      {/* `agen` in the ink colour, inherited so it follows the theme. */}
      <path fill="currentColor" fillRule="evenodd" d={WORD_PATH} clipPath={`url(#${id}-a)`} />
      {/* `FK` in the brand colour. */}
      <path fill="var(--brand)" fillRule="evenodd" d={WORD_PATH} clipPath={`url(#${id}-b)`} />
    </svg>
  );
}
