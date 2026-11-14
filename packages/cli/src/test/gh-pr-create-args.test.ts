/**
 * @vitest-environment node
 *
 * `agenfk pr create --base <branch>` must reach `gh pr create --base <branch>`
 * verbatim: a PR for a branch cut from `beta` opened against `main` because
 * the flag simply did not exist and gh guessed. The assembly is pure now
 * (prArgs.ts) so the arg order — which gh cares about for repeated flags —
 * is pinned here rather than discovered against a live repo.
 */
import { describe, it, expect } from 'vitest';
import { ghPrCreateArgs } from '../prArgs';

describe('ghPrCreateArgs', () => {
  it('always passes the title and body', () => {
    const args = ghPrCreateArgs({ title: 'T', body: 'B' });
    expect(args).toEqual(['pr', 'create', '--title', 'T', '--body', 'B']);
  });

  it('forwards --base verbatim', () => {
    const args = ghPrCreateArgs({ title: 'T', body: 'B', base: 'beta' });
    expect(args).toContain('--base');
    expect(args[args.indexOf('--base') + 1]).toBe('beta');
  });

  it('omits --base entirely when absent — gh keeps its own default detection', () => {
    // No value and no flag: `--base undefined` would be passed to gh as a
    // literal branch name if the caller were careless.
    const args = ghPrCreateArgs({ title: 'T', body: 'B', base: undefined });
    expect(args).not.toContain('--base');
  });

  it('refuses an empty --base the same as a missing one', () => {
    const args = ghPrCreateArgs({ title: 'T', body: 'B', base: '  ' });
    expect(args).not.toContain('--base');
  });

  it('appends --draft when asked', () => {
    const args = ghPrCreateArgs({ title: 'T', body: 'B', draft: true, base: 'beta' });
    expect(args).toContain('--draft');
    expect(args).toContain('--base');
  });
});
