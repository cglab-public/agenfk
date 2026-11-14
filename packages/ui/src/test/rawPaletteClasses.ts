/**
 * What the screen is actually painted with, read back off the DOM.
 *
 * The artifact (aca414c7, section 04) measured this by opening the app and
 * reading `outerHTML` back rather than by grepping the source, and the
 * distinction matters: a class only counts if it reaches an element. A
 * constant holding `bg-slate-800` for a branch nobody renders is not what the
 * user is looking at. Tailwind writes utilities into `class` verbatim, variant
 * prefix and all, so `dark:bg-slate-900` arrives exactly as it was typed —
 * which is what lets one scan catch both halves of a hardcoded pair.
 *
 * WHAT THIS DOES NOT SEE, said here because the first version of this helper
 * promised "the palette comes from the tokens" and delivered one fifth of it:
 *
 *   - CATEGORICAL ramps — red/rose for danger, blue for story, emerald for
 *     done, violet for epic. Those carry meaning, not surface, and the
 *     artifact keeps a colour per item type on purpose. Out of scope by
 *     decision, not by oversight.
 *   - `bg-black/NN`. The modal scrim is not a surface; it is the dimming of
 *     whatever is behind it, and it is black in both themes deliberately.
 *   - `text-white` sitting on a solid accent fill (`bg-red-600`, `bg-brand`).
 *     The ground does not flip, so neither should the ink.
 *   - `prose-slate` and friends. The typography plugin's ramp paints rendered
 *     markdown and is a separate change with its own decision to make; it IS
 *     still hardcoded, and it is still blue.
 *
 * So the name of the thing is "no hardcoded NEUTRAL SURFACE colour", and the
 * tests are named for that rather than for the whole palette.
 */

/**
 * Tailwind's neutral ramps. `slate` is the one that was in use and the one
 * that reads BLUE against a brand palette that is neutral near-black
 * (--canvas #0d0f13); the rest are here so a future swap cannot trade one
 * hardcoded ramp for another.
 */
const RAMPS = ['slate', 'gray', 'zinc', 'neutral', 'stone'];

/** `bg-slate-900`, `dark:border-slate-700`, `hover:text-gray-400/50`. */
const RAMP = new RegExp(String.raw`(?:^|:)[a-z-]*(?:${RAMPS.join('|')})-\d{2,3}(?:\/\d{1,3})?$`);

/**
 * `bg-white` is the light half of a hardcoded pair even when its `dark:` twin
 * is gone — white is not a theme. Backgrounds only: see the note on
 * `text-white` above.
 */
const WHITE_GROUND = /(?:^|:)bg-white(?:\/\d{1,3})?$/;

/**
 * An arbitrary value writes the colour straight into the class name, which no
 * ramp-shaped regex would ever match: `bg-[#0f172a]`, `text-[rgb(15,23,42)]`.
 * This is how a regression gets written after a migration like this one.
 */
const ARBITRARY = /(?:^|:)(?:bg|text|border|divide|from|to|via|ring|shadow)-\[(?:#|rgb|hsl|oklch)/i;

export function rawPaletteClasses(root: ParentNode): string[] {
  const found = new Set<string>();
  const walk = (el: Element): void => {
    // `className` is an SVGAnimatedString on SVG elements, so read the
    // attribute: it is a plain string wherever it exists at all.
    for (const cls of (el.getAttribute('class') ?? '').split(/\s+/)) {
      if (!cls) continue;
      if (RAMP.test(cls) || WHITE_GROUND.test(cls) || ARBITRARY.test(cls)) found.add(cls);
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  for (const el of Array.from(root.children ?? [])) walk(el as Element);
  return [...found].sort();
}

/**
 * A ground and the thing that reacts on it must stay two colours.
 *
 * The migration collapsed `bg-slate-200 … hover:bg-slate-300` onto one token
 * twice, and the No button of a delete confirmation lost its hover beside a
 * Yes that kept one. Nothing failed: a dead affordance renders perfectly.
 * This reads the same DOM and reports elements whose base fill and hover fill
 * are the same class.
 */
export function deadHoverClasses(root: ParentNode): string[] {
  const dead = new Set<string>();
  const walk = (el: Element): void => {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const ground = new Set(classes.filter(c => /^bg-[a-z-]+$/.test(c)));
    for (const c of classes) {
      if (c.startsWith('hover:bg-') && ground.has(c.slice('hover:'.length))) dead.add(c);
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  for (const el of Array.from(root.children ?? [])) walk(el as Element);
  return [...dead].sort();
}
