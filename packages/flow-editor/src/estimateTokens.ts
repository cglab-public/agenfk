/**
 * Client-side token count estimate for exit-criteria markdown (CGLAB-109).
 *
 * Shown under the popup editor so an author can see the context cost of their
 * criteria before saving. The estimate is a heuristic — chars/4 on the
 * trimmed text, the standard GPT-family approximation — not an encoder
 * count: criteria are short text and the purpose is a budget signal, not a
 * billing figure. Pure function, no dependencies. Empty/whitespace input
 * yields 0 naturally (ceil(0/4)); there is no special-casing branch because
 * the expression already covers it (mutation-testing confirmed the branch
 * was an equivalent-mutant trap).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.trim().length / 4);
}
