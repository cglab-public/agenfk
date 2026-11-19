/**
 * `*` in a host list, in the sandbox (user decision 2026-11-02): with every
 * host allowed in either direction the machine's network is open, as in
 * observe - smolvm is given no allow list and the guest resolver answers every
 * name - but the decider and the resolver still refuse the deny list, the IOC
 * hosts and the cloud metadata endpoints. Which way data goes stays judged on
 * tool calls.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { buildSandboxSpec, type SandboxSession } from '../airlock/spec';
import { allowListArgs, decideFlow } from '../airlock/egress';
import { resolverAllowOf } from '../airlock/smolvm';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const session = (): SandboxSession => ({
  client: 'pi', home: '/home/u', workspace: '/work/repo', tempDirs: ['/tmp/x'], inferenceHosts: ['api.openai.com'],
  serverPort: 3123, installDirs: ['/home/u/.agenfk-system'],
});
const spec = (hosts: Record<string, unknown>) => buildSandboxSpec(normalizeAirlockPolicy({
  mode: 'enforce', hosts: { allow: [], deny: [], ...hosts }, iocHosts: { revision: '1', hosts: ['bad.vendor.io'], updatedAt: null },
}), session());

describePosix('`*` opens the sandbox network, denies kept', () => {
  it.each([[{ allowDownload: ['*'] }], [{ allowUpload: ['*'] }], [{ allow: ['*'] }]])('%j: the spec allows every host and skips nothing for it', (hosts) => {
    const s = spec({ ...hosts, deny: ['evil.vendor.io'] });
    expect(s.network.allow).toContain('*');
    expect(s.skipped.map((x) => x.entry)).not.toContain('*');
    expect(s.network.deny).toEqual(expect.arrayContaining(['evil.vendor.io', 'bad.vendor.io', '169.254.169.254', 'metadata.google.internal']));
  });

  it('smolvm is given no allow list (every name resolves, every flow reaches the decider)', () => {
    expect(allowListArgs(spec({ allowDownload: ['*'] }).network)).toEqual(['--reset-allow-list', '--net']);
  });

  it('the decider allows any flow not denied, and refuses a denied, IOC or metadata one', () => {
    const n = spec({ allowDownload: ['*'], deny: ['evil.vendor.io'] }).network;
    expect(decideFlow({ names: ['random.vendor.org'], claimed: 'random.vendor.org', ip: '52.1.2.3', port: 443 }, n).decision).toBe('allow');
    expect(decideFlow({ names: [], ip: '52.1.2.3', port: 443 }, n).decision).toBe('allow');
    for (const [name, ip] of [['evil.vendor.io', '52.1.2.4'], ['bad.vendor.io', '52.1.2.5'], [null, '169.254.169.254']] as const) {
      const d = decideFlow({ names: name ? [name] : [], claimed: name, ip, port: 443 }, n);
      expect(d.decision, `${name ?? ip}`).toBe('deny');
    }
  });

  it('the guest resolver answers every name it does not deny', () => {
    expect(resolverAllowOf(spec({ allowDownload: ['*'] }).network)).toBeUndefined();
  });

  it('without `*` the network stays an allow list, as before', () => {
    const n = spec({ allowDownload: ['docs.vendor.io'] }).network;
    expect(allowListArgs(n)).toContain('--allow-host-pattern');
    expect(decideFlow({ names: ['random.vendor.org'], claimed: 'random.vendor.org', ip: '52.1.2.3', port: 443 }, n).decision).toBe('deny');
    expect(resolverAllowOf(n)).toEqual(expect.arrayContaining(['docs.vendor.io']));
  });
});

describePosix('review (Codex, 2026-11-02)', () => {
  it('a deny smolvm cannot express (*.org, a single label) still refuses under `*`: the decider and the resolver match it as written', () => {
    const s = spec({ allowDownload: ['*'], deny: ['*.org', 'intranet'] });
    expect(s.network.deny).toEqual(expect.arrayContaining(['*.org', 'intranet']));
    expect(decideFlow({ names: ['blocked.example.org'], claimed: 'blocked.example.org', ip: '52.1.2.9', port: 443 }, s.network).decision).toBe('deny');
    expect(decideFlow({ names: ['intranet'], claimed: 'intranet', ip: '52.1.2.10', port: 443 }, s.network).decision).toBe('deny');
  });

  it('without `*` such a deny is still enforced by leaving its allows out, as before', () => {
    const s = spec({ allow: ['a.example.org', 'docs.vendor.io'], deny: ['*.org'] });
    expect(s.network.allow).not.toContain('a.example.org');
    expect(s.skipped.map((x) => x.entry)).toContain('*.org');
  });
});
