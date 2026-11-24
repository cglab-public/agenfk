/**
 * GH-389: after an authorized gatekeeper check, the CLI tells the server which
 * card the harness session is on (POST /session-cards), so that session's
 * turns are charged to that card. The session is the HARNESS's own transcript
 * id (harnessActor), the id the token events carry - not AGENFK_SESSION_ID,
 * which a wrapping harness may set to its own. A failure never fails the
 * gatekeeper, but it is reported, not swallowed.
 */
import { describe, it, expect, vi } from 'vitest';
import { reportSessionCard } from '../activeWork';

describe('reportSessionCard', () => {
  it('posts the harness session and the card', async () => {
    const post = vi.fn(async () => undefined);
    const warning = await reportSessionCard('card-1', { client: 'pi', sessionId: 'pi-sess' }, { post });
    expect(post).toHaveBeenCalledWith({ client: 'pi', sessionId: 'pi-sess', itemId: 'card-1' });
    expect(warning).toBeNull();
  });

  it('with no harness session there is nothing to record: no request, no warning', async () => {
    const post = vi.fn(async () => undefined);
    expect(await reportSessionCard('card-1', null, { post })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('a server that cannot take it does not throw, and says usage will not reach the card', async () => {
    const post = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const warning = await reportSessionCard('card-1', { client: 'claude-code', sessionId: 's' }, { post });
    expect(warning).toMatch(/usage/i);
    expect(warning).toMatch(/ECONNREFUSED/);
  });
});
