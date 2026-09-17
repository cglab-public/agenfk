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
 * carry any of these forms. The two REGEXES are kept byte-identical and the
 * package boundary means they are mirrored rather than shared — change one,
 * change both. The surrounding input handling differs on purpose: the server
 * receives whatever Express put in the query slot (a number, or an array from a
 * repeated `?pr=`) and takes the first entry that parses, while this box is
 * always one string.
 *
 * Callers must mirror the "first entry that parses" rule too when reading a URL.
 * PrOverview seeds the box from `getAll('pr')`, not `get('pr')`, so that
 * `?pr=&pr=57` means the same thing in the browser and on the server.
 */

/** `57` / `#57`, and the number inside a pasted GitHub PR, GitLab MR or
 *  Bitbucket pull-request URL. Bitbucket needs both spellings — `pull-requests`
 *  is Server / Data Center, `pullrequests` (no hyphen) is what Cloud emits, and a
 *  pasted Cloud link that silently means "no filter" is the worst outcome here. */
const PR_NUMBER_RE = /^#?(\d+)$/;
const PR_URL_RE = /\/(?:pull-?requests|pull|merge_requests)\/(\d+)/;

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
