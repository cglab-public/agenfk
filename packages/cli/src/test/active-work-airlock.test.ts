/**
 * BUG 3afbbf7e: inside the Airlock sandbox ~/.agenfk is unwritable, so the gatekeeper's note of
 * the card a session works on was silently lost, and every live dataset row went out with
 * card:null. There the note goes to the server (POST /active-work), which writes it outside the
 * sandbox; everywhere else it is written here as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordActiveWork, activeWorkPath, gatekeeperSessionId } from '../activeWork';

const wipe = (): void => {
  try { fs.rmSync(activeWorkPath(), { force: true }); } catch { /* nothing there */ }
  try { fs.rmSync(path.join(os.homedir(), '.agenfk', 'active-work'), { recursive: true, force: true }); } catch { /* nothing there */ }
};
beforeEach(wipe);
afterEach(wipe);

describe('recordActiveWork', () => {
  it('outside the sandbox it writes the keyed note here and asks the server nothing', async () => {
    const post = vi.fn(async () => undefined);
    await recordActiveWork({ id: 'c1', projectId: 'p1' }, 'sess-1', { env: {}, post });
    expect(post).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(activeWorkPath('sess-1'), 'utf8'))).toMatchObject({ itemId: 'c1', projectId: 'p1' });
  });

  it('inside the Airlock sandbox it hands the note to the server', async () => {
    const post = vi.fn(async () => undefined);
    await recordActiveWork({ id: 'c1', projectId: 'p1' }, 'sess-1', { env: { AGENFK_AIRLOCK_SANDBOX: 'pi' }, post });
    expect(post).toHaveBeenCalledWith({ itemId: 'c1', sessionId: 'sess-1' });
    expect(fs.existsSync(activeWorkPath('sess-1'))).toBe(false);
  });

  it('inside the sandbox without a session there is nothing to key it to: no request', async () => {
    const post = vi.fn(async () => undefined);
    await recordActiveWork({ id: 'c1' }, undefined, { env: { AGENFK_AIRLOCK_SANDBOX: 'pi' }, post });
    expect(post).not.toHaveBeenCalled();
  });

  it('a server that cannot take it never fails the gatekeeper', async () => {
    const post = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(recordActiveWork({ id: 'c1' }, 'sess-1', { env: { AGENFK_AIRLOCK_SANDBOX: 'pi' }, post })).resolves.toBeUndefined();
  });
});

// Review findings C2/C3: pi exports its own session as AGENFK_PI_SESSION_ID. It ranks below
// Claude Code's, so Claude Code started from pi's shell keys its note to its own session.
describe('gatekeeperSessionId', () => {
  it('--session, then AGENFK_SESSION_ID, then Claude Code\'s, then pi\'s', () => {
    const env = { AGENFK_SESSION_ID: 'agenfk', CLAUDE_CODE_SESSION_ID: 'claude', AGENFK_PI_SESSION_ID: 'pi' };
    expect(gatekeeperSessionId('flag', env)).toBe('flag');
    expect(gatekeeperSessionId(undefined, env)).toBe('agenfk');
    expect(gatekeeperSessionId(undefined, { CLAUDE_CODE_SESSION_ID: 'claude', AGENFK_PI_SESSION_ID: 'pi' })).toBe('claude');
    expect(gatekeeperSessionId(undefined, { AGENFK_PI_SESSION_ID: 'pi' })).toBe('pi');
    expect(gatekeeperSessionId(undefined, {})).toBeUndefined();
    expect(gatekeeperSessionId('', { AGENFK_SESSION_ID: '  ' })).toBeUndefined();
  });
});
