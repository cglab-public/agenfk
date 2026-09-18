/**
 * @vitest-environment node
 *
 * The note the gatekeeper writes has to be the note the recorder reads.
 *
 * Two packages build the same file. The CLI writes it — deliberately by hand,
 * because the gatekeeper runs on every edit and must pull in nothing beyond
 * node builtins — and the server parses it with its own validation. Nothing
 * checked that the two agreed.
 *
 * If a field name drifts, the reader's validation rejects the note, the hook
 * opens no run, and the Runs panel is simply empty. Nothing errors. That is
 * the same producer/consumer gap that has bitten this epic repeatedly, and it
 * is invisible precisely because both halves are individually correct.
 *
 * So this is a ROUND TRIP rather than a string comparison: the real writer
 * writes, the real reader reads, and the card that comes back has to be the
 * card that went in. A test that compared field names would pass on two
 * serializers that agree on names and disagree on anything else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeActiveWork } from '../../../cli/src/activeWork';
import { readActiveWorkForSession, activeWorkPath } from '../agent-runs/activeWork';

const wipe = (): void => {
  try { fs.rmSync(activeWorkPath(), { force: true }); } catch { /* nothing there */ }
  try { fs.rmSync(path.join(os.homedir(), '.agenfk', 'active-work'), { recursive: true, force: true }); } catch { /* nothing there */ }
};

beforeEach(wipe);
afterEach(wipe);

describe('what the gatekeeper writes', () => {
  it('is read back as the same card', () => {
    writeActiveWork({ id: 'item-42', projectId: 'proj-7' });
    const read = readActiveWorkForSession(undefined);
    expect(read?.itemId).toBe('item-42');
    expect(read?.projectId).toBe('proj-7');
  });

  it('survives having no project, which the writer allows', () => {
    // `projectId` is optional on the way in, so the reader must not treat its
    // absence as a malformed note and discard the whole thing.
    writeActiveWork({ id: 'item-43' });
    const read = readActiveWorkForSession(undefined);
    expect(read?.itemId).toBe('item-43');
  });

  it('lands where the reader looks', () => {
    // The two halves agree on the PATH as well as the shape. The unkeyed file
    // is the documented fallback for the gatekeeper, which has no session id
    // to key on.
    writeActiveWork({ id: 'item-44' });
    expect(fs.existsSync(activeWorkPath())).toBe(true);
  });

  it('is rejected when it is not a note at all', () => {
    // The reader validates rather than trusting the file, so a hand-edited or
    // truncated one is discarded instead of opening a run against nothing.
    fs.mkdirSync(path.dirname(activeWorkPath()), { recursive: true });
    fs.writeFileSync(activeWorkPath(), '{ "nothing": "useful" }');
    expect(readActiveWorkForSession(undefined)).toBeNull();
  });
});
