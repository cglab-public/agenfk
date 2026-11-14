import clsx, { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The hub's type scale and content widths (@theme in index.css). tailwind-merge
// does not read the theme: without this it took `text-body` for a text COLOUR
// (dropping `text-navy` beside it) and could not let a caller's max-w-[…]
// replace max-w-data.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['caption', 'small', 'body', 'title', 'display'], container: ['form', 'data'] } },
});

/** Join classes and let later ones win (a caller's `className` overrides a default). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
