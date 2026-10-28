/**
 * Airlock layer 2 (GH-294, L2-1): the sandbox spec built from the EFFECTIVE
 * policy the server serves. Pure: no file system, no network, no ASRT.
 */
import { describe, it, expect } from 'vitest';
import { normalizeAirlockPolicy, BUILTIN_DENY_HOSTS, HOME_CREDENTIAL_STORES } from '@agenfk/core';
import {
  buildSandboxSpec,
  writeRootHolding,
  AIRLOCK_SANDBOX_MARKER,
  type SandboxSession,
} from '../airlock/spec';

// The launcher refuses Windows (AsrtRuntime.check, tested there), so these POSIX
// sandbox specs never run on it; their literal POSIX paths would not hold either.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const HOME = '/home/u';
const session = (over: Partial<SandboxSession> = {}): SandboxSession => ({
  client: 'pi',
  home: HOME,
  workspace: '/work/repo',
  tempDirs: ['/tmp/x'],
  inferenceHosts: ['api.openai.com'],
  serverPort: 3123,
  installDirs: ['/home/u/.agenfk-system'],
  ...over,
});
const policy = (over: Record<string, unknown> = {}) =>
  normalizeAirlockPolicy({ mode: 'enforce', ...over });

describe('buildSandboxSpec: network', () => {
  it('allows the policy hosts, the inference host and the local AgEnFK server on loopback only', () => {
    const spec = buildSandboxSpec(policy({ hosts: { allow: ['api.github.com', '*.npmjs.org'], deny: [] } }), session());
    expect(spec.network.allow).toEqual(expect.arrayContaining([
      'api.github.com', '*.npmjs.org', 'api.openai.com', '127.0.0.1:3123', 'localhost:3123',
    ]));
    // The server is allowed on its own port, never loopback as a whole.
    expect(spec.network.allow).not.toContain('localhost');
    expect(spec.network.allow).not.toContain('127.0.0.1');
  });

  it('denies the built-in metadata hosts, the policy deny list and the IOC hosts', () => {
    const spec = buildSandboxSpec(policy({
      hosts: { allow: [], deny: ['evil.example', '*.bad.example'] },
      iocHosts: { revision: 'r1', hosts: ['ioc.example'], updatedAt: null },
    }), session());
    for (const h of ['169.254.169.254', 'metadata.google.internal', '100.100.100.200', '[fd00:ec2::254]',
      'evil.example', '*.bad.example', 'ioc.example']) {
      expect(spec.network.deny).toContain(h);
    }
    expect(BUILTIN_DENY_HOSTS.length).toBe(4);
  });

  it('turns denied CIDR ranges into resolved-address denies, and brackets IPv6 literals', () => {
    const spec = buildSandboxSpec(policy({ hosts: { allow: ['2001:db8::1'], deny: ['10.0.0.0/8', 'fd00::/8'] } }), session());
    expect(spec.network.denyResolved).toEqual(expect.arrayContaining(['10.0.0.0/8', 'fd00::/8']));
    expect(spec.network.deny).not.toContain('10.0.0.0/8');
    expect(spec.network.allow).toContain('[2001:db8::1]');
  });

  it('never widens: allow entries the sandbox cannot express are left out and reported, not turned into allow-all', () => {
    // normalizeAirlockPolicy already drops `*` (it covers the metadata hosts);
    // the builder must not rely on that.
    const raw = { ...policy(), hosts: { allow: ['*', '10.0.0.0/8', 'intranet', 'ok.example.com'], deny: [] } };
    const spec = buildSandboxSpec(raw, session());
    expect(spec.network.allow).toContain('ok.example.com');
    for (const bad of ['*', '10.0.0.0/8', 'intranet']) {
      expect(spec.network.allow).not.toContain(bad);
      expect(spec.skipped.map((s) => s.entry)).toContain(bad);
    }
  });

  it('a session inference host that is not a host is skipped, not allowed', () => {
    const spec = buildSandboxSpec(policy(), session({ inferenceHosts: ['https://api.x.com/v1', 'api.ok.com'] }));
    expect(spec.network.allow).toContain('api.ok.com');
    expect(spec.network.allow.some((h) => h.includes('/'))).toBe(false);
    expect(spec.skipped.map((s) => s.entry)).toContain('https://api.x.com/v1');
  });

  it('allows an inference host on its own port (a local model server), and only that port', () => {
    const spec = buildSandboxSpec(policy(), session({ inferenceHosts: ['127.0.0.1:8081', '[::1]:9000', 'llm.example.com:8443'] }));
    expect(spec.network.allow).toEqual(expect.arrayContaining(['127.0.0.1:8081', '[::1]:9000', 'llm.example.com:8443']));
    expect(spec.network.allow).not.toContain('127.0.0.1');
  });

  it('does not depend on anything but its inputs (same input, same spec)', () => {
    expect(buildSandboxSpec(policy(), session())).toEqual(buildSandboxSpec(policy(), session()));
  });
});

describePosix('buildSandboxSpec: filesystem', () => {
  it('denies reads of the credential stores', () => {
    const { denyRead } = buildSandboxSpec(policy(), session()).filesystem;
    for (const p of ['/home/u/.aws/credentials', '/home/u/.ssh/id_*', '/home/u/.netrc', '/home/u/.docker/config.json',
      '/home/u/.npmrc', '/home/u/.pi/agent/auth.json']) {
      expect(denyRead).toContain(p);
    }
  });

  it('allows writes to the workspace and temp, and denies writes to every AgEnFK control path', () => {
    const { allowWrite, denyWrite } = buildSandboxSpec(policy(), session({ projectAgenfkDirs: ['/work/.agenfk'] })).filesystem;
    expect(allowWrite).toEqual(expect.arrayContaining(['/work/repo', '/tmp/x']));
    for (const p of ['/home/u/.agenfk', '/home/u/.agenfk-system', '/home/u/.pi/agent/extensions',
      '/home/u/.config/opencode/plugins', '/work/repo/.agenfk', '/work/.agenfk', '/work/repo/**/.agenfk']) {
      expect(denyWrite).toContain(p);
    }
  });

  it('lets pi write its own state, and opencode its own, but not the other client', () => {
    const pi = buildSandboxSpec(policy(), session({ client: 'pi' })).filesystem.allowWrite;
    const oc = buildSandboxSpec(policy(), session({ client: 'opencode' })).filesystem.allowWrite;
    expect(pi).toContain('/home/u/.pi/agent');
    expect(pi).not.toContain('/home/u/.local/share/opencode');
    expect(oc).toContain('/home/u/.local/share/opencode');
    expect(oc).not.toContain('/home/u/.pi/agent');
  });

  it('protects the sandbox runtime package from writes', () => {
    const spec = buildSandboxSpec(policy(), session({ runtimePackageDir: '/opt/agenfk/node_modules/@anthropic-ai/sandbox-runtime' }));
    expect(spec.filesystem.denyWrite).toContain('/opt/agenfk/node_modules/@anthropic-ai/sandbox-runtime');
  });
});

describe('buildSandboxSpec: environment and keys', () => {
  it('sets the marker, NODE_USE_ENV_PROXY and routes loopback through the proxy', () => {
    const { env } = buildSandboxSpec(policy(), session());
    expect(env[AIRLOCK_SANDBOX_MARKER]).toBe('pi');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    // srt's NO_PROXY sends loopback direct, which the sandbox refuses; the
    // server is reached through the proxy, on its one allowed port.
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });

  it('masks the model key env vars, injected only to the inference hosts', () => {
    const spec = buildSandboxSpec(policy(), session({ maskedEnv: ['OPENAI_API_KEY'] }));
    expect(spec.maskedEnv).toEqual([{ name: 'OPENAI_API_KEY', injectHosts: ['api.openai.com'] }]);
  });

  it('refuses an env var name that is not one', () => {
    expect(() => buildSandboxSpec(policy(), session({ maskedEnv: ['A B=1'] }))).toThrow(/env/i);
  });

  it('asks for a pseudo-terminal (pi and opencode are TUIs; measured: raw mode is EPERM without it)', () => {
    expect(buildSandboxSpec(policy(), session()).allowPty).toBe(true);
  });
});

describe('writeRootHolding', () => {
  const spec = buildSandboxSpec(policy(), session());
  it('names the write root a path sits in', () => {
    expect(writeRootHolding('/work/repo/node_modules/@anthropic-ai/sandbox-runtime', spec)).toBe('/work/repo');
    expect(writeRootHolding('/work/repo', spec)).toBe('/work/repo');
  });
  it('is null outside every write root (a sibling with a common prefix is outside)', () => {
    expect(writeRootHolding('/home/u/.agenfk-system/node_modules/x', spec)).toBeNull();
    expect(writeRootHolding('/work/repo-other/x', spec)).toBeNull();
  });
});

describe('buildSandboxSpec: deny wins (review fixes 1 and 2)', () => {
  it('drops a literal IP allow that falls inside a denied CIDR (the runtime would dial it)', () => {
    const spec = buildSandboxSpec(policy({ hosts: { allow: ['10.1.2.3', 'api.github.com'], deny: ['10.0.0.0/8'] } }), session());
    expect(spec.network.allow).not.toContain('10.1.2.3');
    expect(spec.network.allow).toContain('api.github.com');
    expect(spec.skipped.find((s) => s.entry === '10.1.2.3')?.reason).toMatch(/denied/);
  });

  it('drops allows a wildcard deny matches, even one the runtime cannot express', () => {
    const spec = buildSandboxSpec(policy({ hosts: { allow: ['svc.internal', 'a.corp.internal', 'api.github.com', 'ok.example.org'], deny: ['*.internal', '*.com'] } }), session({ inferenceHosts: ['api.ok.org'] }));
    for (const gone of ['svc.internal', 'a.corp.internal', 'api.github.com']) expect(spec.network.allow).not.toContain(gone);
    expect(spec.network.allow).toContain('ok.example.org');
    // The inexpressible denies are reported, not silently dropped.
    expect(spec.skipped.map((s) => s.entry)).toEqual(expect.arrayContaining(['*.internal', '*.com']));
  });

  it('a denied wildcard allow goes too', () => {
    const raw = { ...policy(), hosts: { allow: ['*.corp.internal'], deny: ['*.internal'] } };
    expect(buildSandboxSpec(raw, session()).network.allow).not.toContain('*.corp.internal');
  });

  it('refuses when the inference host is denied (by name, wildcard or range)', () => {
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['*.openai.com'] } }), session())).toThrow(/inference host.*api\.openai\.com.*denied/s);
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['10.0.0.0/8'] } }), session({ inferenceHosts: ['10.0.0.5:8080'] }))).toThrow(/inference host/);
    expect(() => buildSandboxSpec(policy({ iocHosts: { revision: 'r', hosts: ['api.openai.com'], updatedAt: null } }), session())).toThrow(/inference host/);
  });

  it('the AgEnFK server allow goes too when loopback is denied (reported)', () => {
    const spec = buildSandboxSpec(policy({ hosts: { allow: [], deny: ['127.0.0.0/8'] } }), session());
    expect(spec.network.allow).not.toContain('127.0.0.1:3123');
    expect(spec.skipped.map((s) => s.entry)).toContain('127.0.0.1:3123');
  });
});

describePosix('buildSandboxSpec: credential stores and injection (review fixes 4 and 5)', () => {
  it('denies reads of every credential store layer 1 knows, plus the clients\' own key files', () => {
    const { denyRead } = buildSandboxSpec(policy(), session()).filesystem;
    for (const p of HOME_CREDENTIAL_STORES) expect(denyRead).toContain(`/home/u/${p}`);
    for (const p of ['.aws/sso/cache', '.git-credentials', '.pypirc', '.kube/config', '.config/gcloud', '.azure']) {
      expect(denyRead).toContain(`/home/u/${p}`);
    }
  });

  it('injects a masked key by host name: the allow keeps the port, the inject host does not', () => {
    const spec = buildSandboxSpec(policy(), session({ inferenceHosts: ['llm.example.com:8443'], maskedEnv: ['K'] }));
    expect(spec.network.allow).toContain('llm.example.com:8443');
    expect(spec.maskedEnv).toEqual([{ name: 'K', injectHosts: ['llm.example.com'] }]);
    const v6 = buildSandboxSpec(policy(), session({ inferenceHosts: ['[::1]:9000'], maskedEnv: ['K'] }));
    expect(v6.maskedEnv[0].injectHosts).toEqual(['[::1]']);
  });
});

describe('buildSandboxSpec: localhost is loopback (second pass, fix 2)', () => {
  it('a loopback deny drops localhost and *.localhost allows, the server exception included', () => {
    for (const deny of ['127.0.0.0/8', '127.0.0.1']) {
      const raw = { ...policy(), hosts: { allow: ['localhost', 'app.localhost', '*.localhost'], deny: [deny] } };
      const allow = buildSandboxSpec(raw, session()).network.allow;
      for (const gone of ['localhost', 'app.localhost', '*.localhost', 'localhost:3123', '127.0.0.1:3123']) expect(allow, `${deny} ${gone}`).not.toContain(gone);
    }
  });

  it('an IPv6 loopback deny drops localhost too (localhost answers ::1), but not the IPv4 literal', () => {
    const allow = buildSandboxSpec(policy({ hosts: { allow: [], deny: ['::1'] } }), session()).network.allow;
    expect(allow).not.toContain('localhost:3123');
    expect(allow).toContain('127.0.0.1:3123');
    const v6range = buildSandboxSpec(policy({ hosts: { allow: [], deny: ['::1/128'] } }), session()).network.allow;
    expect(v6range).not.toContain('localhost:3123');
  });

  it('refuses an inference endpoint on localhost when loopback is denied', () => {
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['127.0.0.0/8'] } }), session({ inferenceHosts: ['localhost:8081'] }))).toThrow(/inference host/);
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['::1'] } }), session({ inferenceHosts: ['llm.localhost:8081'] }))).toThrow(/inference host/);
  });

  it('without a loopback deny, localhost stays', () => {
    expect(buildSandboxSpec(policy(), session()).network.allow).toContain('localhost:3123');
  });
});

describe('buildSandboxSpec: any loopback deny takes localhost out (third pass)', () => {
  it('a deny of one loopback address drops every localhost name, the server exception included', () => {
    for (const deny of ['127.0.0.2/32', '127.0.0.2', '127.5.0.0/16', '::1/128']) {
      const raw = { ...policy(), hosts: { allow: ['llm.localhost', 'localhost', '*.localhost'], deny: [deny] } };
      const allow = buildSandboxSpec(raw, session()).network.allow;
      for (const gone of ['llm.localhost', 'localhost', '*.localhost', 'localhost:3123']) expect(allow, `${deny} ${gone}`).not.toContain(gone);
    }
  });

  it('refuses an inference endpoint on a localhost name when any loopback address is denied', () => {
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['127.0.0.2/32'] } }), session({ inferenceHosts: ['llm.localhost:8081'] }))).toThrow(/inference host/);
    expect(() => buildSandboxSpec(policy({ hosts: { allow: [], deny: ['127.0.0.2/32'] } }), session({ inferenceHosts: ['localhost:8081'] }))).toThrow(/inference host/);
  });

  it('a deny outside loopback leaves localhost names alone', () => {
    const raw = { ...policy(), hosts: { allow: ['llm.localhost'], deny: ['10.0.0.0/8', '128.0.0.1', '::2'] } };
    const allow = buildSandboxSpec(raw, session({ inferenceHosts: ['localhost:8081'] })).network.allow;
    expect(allow).toEqual(expect.arrayContaining(['llm.localhost', 'localhost:3123', 'localhost:8081']));
  });
});
