/**
 * The message an admin should see when a request fails.
 *
 * Prefers the hub's own `{ error }` body, because that is the sentence written
 * for this situation — "invite token already used" beats "Request failed with
 * status code 400". Falls back to the transport error, then to something
 * rather than nothing, since a mutation that fails silently reads as a click
 * that never registered.
 */
export function apiErrorText(e: unknown): string {
  const fromServer = (e as any)?.response?.data?.error;
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer;
  const message = (e as any)?.message;
  if (typeof message === 'string' && message.trim()) return message;
  return 'Request failed';
}
