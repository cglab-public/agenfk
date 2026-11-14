/**
 * The AgEnFK flag mark on its own, with no wordmark beside it.
 *
 * Distinct from Logo, which is the full lockup: the CG/lab spark, the AgEnFK
 * wordmark and the "BY CG/LAB" byline. A top bar is too short for a lockup and
 * too repetitive a place to spell the product's name out, so the flag carries
 * the identity there by itself. Both are expected to exist; neither replaces
 * the other.
 *
 * Geometry comes from agenfkFlagPath.ts, which is the brand book's own path
 * data rather than anything drawn here. See that file for why that matters.
 */
import { FLAG_MARK_ASPECT, FLAG_MARK_PATH, FLAG_MARK_VIEWBOX } from './agenfkFlagPath';

export interface AgenfkFlagProps {
  /**
   * Rendered height in px. The flag is roughly 1.6 times wider than it is
   * tall, so width follows from this rather than being set independently -
   * a bar sets the height it has room for and lets the mark take the width it
   * needs.
   */
  size?: number;
  /** Accessible name. Worth setting when the mark doubles as a link or button. */
  label?: string;
  className?: string;
}

export function AgenfkFlag({ size = 24, label = 'AgEnFK', className = '' }: AgenfkFlagProps) {
  return (
    <svg
      viewBox={FLAG_MARK_VIEWBOX}
      /*
       * Not rounded. Rounding the width but not the height moves the rendered
       * ratio off the real one by up to half a pixel, which at top-bar sizes
       * is a visible fraction; the mark then letterboxes inside its own box
       * instead of filling it. A fractional length is perfectly legal here.
       */
      width={size * FLAG_MARK_ASPECT}
      height={size}
      role="img"
      aria-label={label}
      /*
       * text-ink is the one colour that is legible on both grounds: it
       * resolves to near-black in the light theme and near-white in the dark
       * one, which is exactly the pair the brand book specifies for the mark.
       *
       * A caller's className is appended for layout and opacity. It is not a
       * reliable way to recolour the mark: Tailwind decides between two
       * competing utilities by their order in the generated stylesheet, not by
       * their order in this attribute, and there is no tailwind-merge in this
       * repo to resolve the conflict. To paint the flag some other colour, set
       * `color` on an ancestor and let currentColor inherit it.
       */
      className={`text-ink ${className}`.trim()}
    >
      <title>{label}</title>
      <path fill="currentColor" fillRule="evenodd" d={FLAG_MARK_PATH} />
    </svg>
  );
}
