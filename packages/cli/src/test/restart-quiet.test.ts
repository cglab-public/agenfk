/**
 * `agenfk restart --quiet` (and the auto-restart-after-fleet-upgrade path)
 * must NOT open a browser window. The user-facing contract exercised here is
 * that both `restart` and `up` accept a `--quiet` flag (restart passes it
 * through to up), so a fleet-triggered restart can suppress the dashboard tab.
 *
 * Behaviour-based: introspect the real constructed commander `program` object
 * rather than grepping cli/index.ts. (The start-services.mjs browser-open gate
 * and the install.mjs restart wiring are environmental script behaviour, not a
 * cli-surface contract, and were dropped in the behaviour-based conversion.)
 */
import { describe, it, expect } from 'vitest';
import { program } from '../index';

function optionLongs(commandName: string): string[] {
  const cmd = program.commands.find((c) => c.name() === commandName);
  expect(cmd, `command "${commandName}" should be registered`).toBeDefined();
  return (cmd as any).options.map((o: any) => o.long);
}

describe('agenfk restart/up --quiet flag', () => {
  it('the restart command accepts --quiet', () => {
    expect(optionLongs('restart')).toContain('--quiet');
  });

  it('the up command accepts --quiet (so restart can pass it through)', () => {
    expect(optionLongs('up')).toContain('--quiet');
  });
});
