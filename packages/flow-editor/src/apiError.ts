/**
 * Pull the human-readable reason out of a failed API call.
 *
 * BUG 269eeec8 (a): the editor rendered `(error as Error).message`, which for an
 * axios rejection is the useless "Request failed with status code 400". Every
 * REST surface in this repo answers a refusal with `{ error: "<reason>" }` — the
 * local server's hub-managed guard, the Hub's flow-definition validator — and
 * that body is the only text that tells the user what to fix. Discarding it made
 * two separate defects look like the same unexplained failure.
 *
 * Lives in the shared package because the editor runs against two different
 * axios instances (packages/ui and packages/hub-ui); a fix in either caller
 * would leave the other blind.
 */

/** Narrow an unknown thrown value to something with a `response.data`. */
function responseData(e: unknown): unknown {
  if (!e || typeof e !== 'object') return undefined;
  const response = (e as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  return (response as { data?: unknown }).data;
}

/** Longest reason worth putting in a one-line error paragraph. */
const MAX_REASON_LENGTH = 300;

function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  // A proxy or gateway answering with an HTML error page would otherwise dump
  // the whole document into the error line — worse than the generic message.
  if (/^\s*<(?:!doctype|html|head|body)\b/i.test(value)) return null;
  return value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;
}

/**
 * @param e        the thrown value (axios error, Error, or anything at all)
 * @param fallback used only when nothing usable can be recovered
 */
export function extractApiError(e: unknown, fallback = 'Something went wrong.'): string {
  const data = responseData(e);

  // Server-supplied reason, in preference order.
  const fromBody =
    nonBlank(data) ??
    (data && typeof data === 'object'
      ? nonBlank((data as { error?: unknown }).error) ?? nonBlank((data as { message?: unknown }).message)
      : null);
  if (fromBody) return fromBody;

  // No usable body — fall back to the transport/JS error text, which at least
  // distinguishes a network failure from a rejected request.
  if (e && typeof e === 'object') {
    const message = nonBlank((e as { message?: unknown }).message);
    if (message) return message;
  }

  return fallback;
}
