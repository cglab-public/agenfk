/**
 * The PR Overview's PR-number search box — the parsing half, kept out of the
 * component so it can be unit-tested without a DOM.
 *
 * Why the box accepts more than digits: a PR number is almost never typed from
 * memory. It is copied from the GitHub issue header (`#57`) or pasted straight
 * out of the address bar. Making people strip the decoration before searching
 * would leave the friction in place, which is the whole thing this feature
 * removes.
 *
 * Anything that is not a number parses to `null` = **no search**, so a half-typed
 * box ("12a") leaves the overview showing the normal window rather than an empty
 * page that reads like the data disappeared.
 *
 * The hub parses the same grammar server-side (`packages/hub/src/queries/
 * pr-overview-aggregate.ts` → `parsePrNumberFilter`) because a shared link can
 * carry any of these forms. The two are deliberately identical; the hub package
 * is a server the browser cannot import, so the rules are mirrored rather than
 * shared — change one, change both.
 */

/** `57` / `#57`, and the number inside a pasted GitHub PR or GitLab MR URL. */
const PR_NUMBER_RE = /^#?(\d+)$/;
const PR_URL_RE = /\/(?:pull|merge_requests)\/(\d+)/;

export function parsePrQuery(raw: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = PR_NUMBER_RE.exec(s) ?? PR_URL_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  // 0 is not a PR number, and past MAX_SAFE_INTEGER the value can no longer be
  // compared exactly against the stored number — a match would be a rounding
  // coincidence, so it is not a search.
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
