/**
 * Which api_key labels mark a key as belonging to exactly ONE machine.
 *
 * The hub mints these itself, in the two onboarding flows, and only those two
 * flows can write them:
 *   - `/invite/redeem` burns the invite nonce inside the transaction that mints
 *     the key, so one invite token cannot produce two keys;
 *   - `/device/approve` mints exactly one key per approved code.
 * One such key therefore cannot have been handed to several machines — which is
 * what makes it safe to bind to the single machine that reports through it.
 *
 * `invite` with no colon is included because an OLD CLI that redeems an invite
 * without sending an identity gets exactly that label (connect.ts), and it is
 * the same single-use token as the prefixed form. Excluding it would leave that
 * machine permanently unbound for no reason — the device twin, `device:<code>`,
 * always carries its colon, so the two flows are not symmetric by accident.
 *
 * This predicate is an AUTHZ-ADJACENT rule, not presentation: binding the wrong
 * key to the wrong machine makes the rest of that machine's fleet traffic get
 * refused as `foreign_installation`. So it must hold on the way IN as well —
 * `POST /v1/admin/api-keys` rejects these labels rather than letting a caller
 * manufacture one, which keeps "the prefix is hub-written" true by construction
 * instead of by convention.
 */
export function isOnboardingKeyLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return l === 'invite' || l.startsWith('invite:') || l.startsWith('device:');
}
