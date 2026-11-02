/**
 * Board routes deliberately without an `agenfk hub admin` command, each with
 * the reason (CGLAB-702). The parity guard (hub-admin-parity.test.ts) fails on
 * any route behind the hub's session or admin guard that is neither called by
 * a command nor listed here.
 */
export const NOT_IN_CLI: Record<string, string> = {
  'POST /hub/admin-device/approve':
    'approving an admin CLI sign-in is a person at the board, signed in as themselves; the hub refuses it from a CLI session, so a token cannot renew itself',
  'POST /hub/federation/invite/create':
    'the same child-hub invite as POST /v1/admin/child-hubs/invite (mintChildHubInvite), which `child-hubs invite` calls',
};
