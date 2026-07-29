/**
 * BUG 269eeec8 defect (a) — the flow editor showed only "Request failed with
 * status code N" because it read `Error.message` off the axios error instead of
 * the server's response body. Every REST surface in this repo answers a refusal
 * with `{ error: "<reason>" }`, so that body is the only thing that tells the
 * user what to fix. The editor is shared by packages/ui and packages/hub-ui with
 * two different axios instances, so the extraction lives here rather than in
 * either caller.
 */
import { describe, it, expect } from 'vitest';
import { extractApiError } from '../apiError';

/** Shape axios produces: the useful text is in response.data, not in message. */
const axiosLike = (status: number, data: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data },
});

describe('extractApiError', () => {
  it("prefers the server's `error` field over the generic axios message", () => {
    const e = axiosLike(409, { error: "Flow is managed by your organization's Hub and cannot be modified locally" });
    expect(extractApiError(e)).toBe("Flow is managed by your organization's Hub and cannot be modified locally");
  });

  it('surfaces a validation reason so the user knows which field is wrong', () => {
    expect(extractApiError(axiosLike(400, { error: 'each step requires a name' }))).toBe('each step requires a name');
  });

  it('falls back to `message` when the body uses that key instead', () => {
    expect(extractApiError(axiosLike(500, { message: 'boom' }))).toBe('boom');
  });

  it('uses a plain string body as-is', () => {
    expect(extractApiError(axiosLike(502, 'upstream exploded'))).toBe('upstream exploded');
  });

  it('keeps the axios message when the body carries no usable reason', () => {
    expect(extractApiError(axiosLike(400, {}))).toBe('Request failed with status code 400');
  });

  it('keeps the axios message when there is no response at all (network error)', () => {
    expect(extractApiError({ isAxiosError: true, message: 'Network Error' })).toBe('Network Error');
  });

  // A proxy/gateway 502 answers with an HTML document, not a reason. Dumping the
  // page source into a one-line error paragraph is worse than the generic text.
  it('ignores an HTML error page body', () => {
    const html = '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>';
    expect(extractApiError(axiosLike(502, html))).toBe('Request failed with status code 502');
  });

  it('truncates an over-long reason instead of rendering a wall of text', () => {
    const long = 'x'.repeat(1000);
    const out = extractApiError(axiosLike(400, { error: long }));
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles a non-axios Error', () => {
    expect(extractApiError(new Error('Flow must be saved before publishing.')))
      .toBe('Flow must be saved before publishing.');
  });

  it('returns the supplied fallback for a thrown non-error value', () => {
    expect(extractApiError(undefined, 'Failed to save flow.')).toBe('Failed to save flow.');
    expect(extractApiError(null, 'Failed to save flow.')).toBe('Failed to save flow.');
  });

  // A blank reason is no reason: it must behave exactly like an absent one
  // (above), falling through to the axios message rather than being rendered as
  // an empty red line. The fallback is reserved for having no text at all.
  it('treats a whitespace-only reason as absent and keeps the axios message', () => {
    expect(extractApiError(axiosLike(400, { error: '   ' }), 'Failed to save flow.'))
      .toBe('Request failed with status code 400');
  });
});
