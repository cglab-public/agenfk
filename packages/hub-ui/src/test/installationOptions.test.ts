/**
 * The fleet-upgrade installation picker.
 *
 * Observed in production (BUG bb27c0aa): the picker listed 12 rows for 7
 * machines because it was built from api_keys — one row per KEY. Installation
 * 97f4db4c held six live keys, so it rendered six times, and the count read
 * "All (12)" while scope=all targets nine. Two machines were missing outright:
 * their live keys had a NULL installation_id, and the old
 * `.filter(k => k.installationId)` dropped them, so they could not be seen or
 * selected at all.
 *
 * One row per INSTALLATION is what the fleet actually upgrades.
 */
import { describe, it, expect } from 'vitest';
import { buildInstallationOptions } from '../pages/installationOptions';

const INST_A = '97f4db4c-e664-40a5-93fc-9108a10d0f51';
const INST_B = '84a72a3f-40dc-4066-8014-b50772ac8611';
const INST_C = 'd13762b1-b2d4-47cc-9693-e822b15e6608';

const inst = (over: Partial<{ id: string; gitName: string | null; gitEmail: string | null; osUser: string | null; retired: boolean }>) => ({
  id: INST_A,
  gitName: null as string | null,
  gitEmail: null as string | null,
  osUser: null as string | null,
  retired: false,
  ...over,
});

const key = (over: Partial<{ installationId: string | null; label: string | null; gitName: string | null; gitEmail: string | null; osUser: string | null; revokedAt: string | null }>) => ({
  installationId: INST_A,
  label: null as string | null,
  gitName: null as string | null,
  gitEmail: null as string | null,
  osUser: null as string | null,
  revokedAt: null,
  ...over,
});

describe('buildInstallationOptions', () => {
  it('lists ONE row per installation, however many keys it holds', () => {
    // The reported duplicate: six live keys, one machine.
    const options = buildInstallationOptions(
      [inst({ id: INST_A, gitName: 'Daniel Polistchuck', gitEmail: 'danielp@cglab.com' })],
      [
        key({ label: 'invite:danielp@cglab.com' }),
        key({ label: 'device:danielp@cglab.com' }),
        key({ label: 'device:danielp@cglab.com' }),
        key({ label: 'device:danielp@cglab.com' }),
        key({ label: 'device:danielp@cglab.com' }),
        key({ label: 'invite:danielp@cglab.com' }),
      ],
    );

    expect(options).toHaveLength(1);
    expect(options[0].id).toBe(INST_A);
  });

  it('includes a machine that has NO bound key at all', () => {
    // The reported missing users: installations exist from their events, but
    // their live keys were unbound, so a key-derived list dropped them.
    const options = buildInstallationOptions(
      [
        inst({ id: INST_B, gitName: 'Diego Pereira da Penha', gitEmail: 'diego.penha@cglab.com' }),
        inst({ id: INST_C, gitName: 'Guilherme Siqueira', gitEmail: 'guilherme.siqueira@cglab.com' }),
      ],
      [],
    );

    expect(options.map(o => o.id).sort()).toEqual([INST_B, INST_C].sort());
  });

  it('labels from the LIVE installations identity, not the stale api-key snapshot', () => {
    // Felipe's machine shipped as the issue-time label `invite:felipedasilvasantos`
    // long after its real identity was known.
    const options = buildInstallationOptions(
      [inst({ id: INST_A, gitName: 'Felipe da Silva Santos', gitEmail: 'felipe.santos@cglab.com' })],
      [key({ label: 'invite:felipedasilvasantos' })],
    );

    expect(options[0].label).toContain('felipe.santos@cglab.com');
    expect(options[0].label).not.toContain('invite:felipedasilvasantos');
  });

  it('excludes retired installations', () => {
    const options = buildInstallationOptions(
      [inst({ id: INST_A }), inst({ id: INST_B, retired: true })],
      [],
    );

    expect(options.map(o => o.id)).toEqual([INST_A]);
  });

  it('is empty for an empty fleet', () => {
    expect(buildInstallationOptions([], [])).toEqual([]);
  });
});
