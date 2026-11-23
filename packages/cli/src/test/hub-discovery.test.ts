/**
 * Story 76da75ea (INFRA-463): the CLI finds the Hub without being told.
 *
 * discoverHub() walks four sources, first match wins:
 *   env (AGENFK_HUB_URL) > managed file (MDM) > ~/.agenfk/hub.json
 *   > DNS TXT _agenfk-hub.<git email domain>
 * A candidate counts only over https and only when GET <url>/healthz answers
 * service=agenfk-hub. A malformed source is reported in `reasons` and skipped,
 * never thrown. No network call (DNS or the health probe) may block past 3 s.
 *
 * Every dependency is injected through fakeDeps(): no test here touches the
 * real filesystem, /etc, the home directory, DNS or the network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'path';
import {
  discoverHub,
  managedConfigPath,
  parseHubTxt,
  DISCOVERY_TIMEOUT_MS,
  type DiscoveryDeps,
} from '../hub/discovery';

const HOME = '/home/dev';
const LINUX_MANAGED = '/etc/agenfk/managed.json';
// discoverHub builds this with path.join, so the key must follow the host's separator.
const USER_FILE = path.join(HOME, '.agenfk', 'hub.json');
const TXT_NAME = '_agenfk-hub.acme.com';

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
}

/**
 * A complete set of fakes. Files are a path -> contents map; healthy is the
 * set of base URLs whose /healthz answers service=agenfk-hub; txt is the
 * record list resolveTxt returns per name (node's string[][] shape).
 */
function fakeDeps(opts: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  files?: Record<string, string>;
  gitEmail?: string | null;
  txt?: Record<string, string[][]>;
  healthy?: string[];
  health?: (url: string) => Promise<{ status: number; data: any }>;
  resolveTxt?: (name: string) => Promise<string[][]>;
} = {}): DiscoveryDeps & { calls: { health: string[]; txt: string[]; read: string[] } } {
  const calls = { health: [] as string[], txt: [] as string[], read: [] as string[] };
  const files = opts.files ?? {};
  const healthy = new Set(opts.healthy ?? []);
  return {
    calls,
    env: opts.env ?? {},
    platform: opts.platform ?? 'linux',
    homedir: () => HOME,
    readFile: async (p: string) => {
      calls.read.push(p);
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      throw enoent(p);
    },
    gitEmail: async () => (opts.gitEmail === undefined ? null : opts.gitEmail),
    resolveTxt: opts.resolveTxt ?? (async (name: string) => {
      calls.txt.push(name);
      const recs = opts.txt?.[name];
      if (!recs) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return recs;
    }),
    httpGet: async (url: string, _o: { timeoutMs: number }) => {
      calls.health.push(url);
      if (opts.health) return opts.health(url);
      const base = url.replace(/\/healthz$/, '');
      if (healthy.has(base)) return { status: 200, data: { ok: true, service: 'agenfk-hub' } };
      return { status: 200, data: { ok: true, service: 'something-else' } };
    },
  };
}

const managed = (o: Record<string, unknown>) => JSON.stringify(o);
const userFile = (url: string) => JSON.stringify({ url, token: 'tok', orgId: 'acme' });

afterEach(() => {
  vi.useRealTimers();
});

describe('precedence: first healthy source wins, in the order the card fixes', () => {
  const ALL = {
    env: { AGENFK_HUB_URL: 'https://env.example.com' },
    files: {
      [LINUX_MANAGED]: managed({ hubUrl: 'https://managed.example.com', orgId: 'org-managed' }),
      [USER_FILE]: userFile('https://user.example.com'),
    },
    gitEmail: 'dev@acme.com',
    txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub.acme.com; org=org-dns']] },
    healthy: [
      'https://env.example.com', 'https://managed.example.com',
      'https://user.example.com', 'https://hub.acme.com',
    ],
  };

  it('AGENFK_HUB_URL wins over the managed file, the user file and DNS', async () => {
    const r = await discoverHub(fakeDeps(ALL));
    expect(r).toMatchObject({ url: 'https://env.example.com', source: 'env' });
  });

  it('the managed file wins over the user file and DNS', async () => {
    const r = await discoverHub(fakeDeps({ ...ALL, env: {} }));
    expect(r).toMatchObject({ url: 'https://managed.example.com', source: 'managed', orgId: 'org-managed' });
  });

  it('~/.agenfk/hub.json wins over DNS', async () => {
    const files = { [USER_FILE]: ALL.files[USER_FILE] };
    const r = await discoverHub(fakeDeps({ ...ALL, env: {}, files }));
    expect(r).toMatchObject({ url: 'https://user.example.com', source: 'user' });
  });

  it('DNS is the last resort', async () => {
    const r = await discoverHub(fakeDeps({ ...ALL, env: {}, files: {} }));
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'dns', orgId: 'org-dns' });
  });

  it('nothing found: url is null and every source says why', async () => {
    const r = await discoverHub(fakeDeps({ gitEmail: 'dev@acme.com' }));
    expect(r.url).toBeNull();
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join('\n')).toContain(TXT_NAME);
  });

  it('a higher source that matched means lower sources are not probed (no needless network)', async () => {
    const deps = fakeDeps(ALL);
    await discoverHub(deps);
    expect(deps.calls.health).toEqual(['https://env.example.com/healthz']);
    expect(deps.calls.txt).toEqual([]);
  });

  it('an empty AGENFK_HUB_URL is no source at all', async () => {
    const r = await discoverHub(fakeDeps({
      env: { AGENFK_HUB_URL: '' },
      files: { [USER_FILE]: userFile('https://user.example.com') },
      healthy: ['https://user.example.com'],
    }));
    expect(r).toMatchObject({ url: 'https://user.example.com', source: 'user' });
  });

});

describe('accept(): normalising what a source names', () => {
  it('strips a trailing slash from the accepted URL', async () => {
    const r = await discoverHub(fakeDeps({ env: { AGENFK_HUB_URL: 'https://env.example.com/' }, healthy: ['https://env.example.com'] }));
    expect(r).toMatchObject({ url: 'https://env.example.com', source: 'env' });
  });

  it('a non-URL value is refused, not thrown', async () => {
    const r = await discoverHub(fakeDeps({ env: { AGENFK_HUB_URL: 'hub.acme.com' } }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => /is not a URL/.test(x))).toBe(true);
  });
});

describe('managed config file: path per platform', () => {
  it('Linux (and WSL, which reports linux) reads /etc/agenfk/managed.json', () => {
    expect(managedConfigPath('linux', {})).toBe('/etc/agenfk/managed.json');
  });

  it('macOS reads /Library/Application Support/AgEnFK/managed.json', () => {
    expect(managedConfigPath('darwin', {})).toBe('/Library/Application Support/AgEnFK/managed.json');
  });

  // %ProgramData% lets a standard user create folders, so a file there could be
  // planted by anyone on the machine; Program Files is admin-only.
  it('Windows reads %ProgramFiles%\\AgEnFK\\managed.json', () => {
    expect(managedConfigPath('win32', { ProgramFiles: 'D:\\PF' })).toBe('D:\\PF\\AgEnFK\\managed.json');
  });

  it('Windows falls back to C:\\Program Files when %ProgramFiles% is unset', () => {
    expect(managedConfigPath('win32', {})).toBe('C:\\Program Files\\AgEnFK\\managed.json');
  });

  it('Windows never reads a managed file under %ProgramData%', () => {
    expect(managedConfigPath('win32', { ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files' })).not.toMatch(/ProgramData/);
  });

  it('discoverHub reads the platform path it was given, not the host one', async () => {
    const mac = '/Library/Application Support/AgEnFK/managed.json';
    const deps = fakeDeps({
      platform: 'darwin',
      files: { [mac]: managed({ hubUrl: 'https://managed.example.com' }) },
      healthy: ['https://managed.example.com'],
    });
    const r = await discoverHub(deps);
    expect(r).toMatchObject({ url: 'https://managed.example.com', source: 'managed' });
    expect(deps.calls.read).toContain(mac);
    expect(deps.calls.read).not.toContain(LINUX_MANAGED);
  });

  it('Windows: the managed file under %ProgramFiles% is used', async () => {
    const win = 'D:\\PF\\AgEnFK\\managed.json';
    const r = await discoverHub(fakeDeps({
      platform: 'win32',
      env: { ProgramFiles: 'D:\\PF' },
      files: { [win]: managed({ hubUrl: 'https://managed.example.com' }) },
      healthy: ['https://managed.example.com'],
    }));
    expect(r).toMatchObject({ url: 'https://managed.example.com', source: 'managed' });
  });
});

describe('managed config file: parsing', () => {
  it('carries orgId through, and no requireHub field (it was never acted on)', async () => {
    const r = await discoverHub(fakeDeps({
      files: { [LINUX_MANAGED]: managed({ hubUrl: 'https://managed.example.com', orgId: 'acme', requireHub: true }) },
      healthy: ['https://managed.example.com'],
    }));
    expect(r).toMatchObject({ url: 'https://managed.example.com', source: 'managed', orgId: 'acme' });
    expect(r).not.toHaveProperty('requireHub');
  });

  it('malformed JSON is reported and skipped, and the next source is used', async () => {
    const r = await discoverHub(fakeDeps({
      files: { [LINUX_MANAGED]: '{ "hubUrl": "https://managed.example.com", ', [USER_FILE]: userFile('https://user.example.com') },
      healthy: ['https://managed.example.com', 'https://user.example.com'],
    }));
    expect(r).toMatchObject({ url: 'https://user.example.com', source: 'user' });
    expect(r.reasons.some(x => x.includes(LINUX_MANAGED) && /malformed|invalid|JSON/i.test(x))).toBe(true);
  });

  it('valid JSON without a string hubUrl is reported and skipped', async () => {
    const r = await discoverHub(fakeDeps({
      files: { [LINUX_MANAGED]: managed({ hubURL: 'https://typo.example.com', orgId: 'acme' }) },
      healthy: ['https://typo.example.com'],
    }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes(LINUX_MANAGED) && /hubUrl/.test(x))).toBe(true);
  });

  it('an unreadable managed file (not ENOENT) is reported, not thrown', async () => {
    const deps = fakeDeps({ files: { [USER_FILE]: userFile('https://user.example.com') }, healthy: ['https://user.example.com'] });
    const read = deps.readFile;
    deps.readFile = async (p: string) => {
      if (p === LINUX_MANAGED) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return read(p);
    };
    const r = await discoverHub(deps);
    expect(r).toMatchObject({ url: 'https://user.example.com', source: 'user' });
    expect(r.reasons.some(x => x.includes(LINUX_MANAGED) && /EACCES|permission/i.test(x))).toBe(true);
  });
});

describe('user file ~/.agenfk/hub.json', () => {
  it('is read from the injected home directory', async () => {
    const deps = fakeDeps({ files: { [USER_FILE]: userFile('https://user.example.com') }, healthy: ['https://user.example.com'] });
    const r = await discoverHub(deps);
    expect(r).toMatchObject({ url: 'https://user.example.com', source: 'user', orgId: 'acme' });
    expect(deps.calls.read).toContain(USER_FILE);
  });

  it('malformed JSON is reported and skipped', async () => {
    const r = await discoverHub(fakeDeps({
      files: { [USER_FILE]: 'not json' },
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub.acme.com']] },
      healthy: ['https://hub.acme.com'],
    }));
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'dns' });
    expect(r.reasons.some(x => x.includes(USER_FILE))).toBe(true);
  });
});

describe('parseHubTxt', () => {
  it('parses v, url and org', () => {
    expect(parseHubTxt('v=agenfk1; url=https://hub.acme.com; org=acme'))
      .toEqual({ url: 'https://hub.acme.com', orgId: 'acme' });
  });

  it('org is optional', () => {
    expect(parseHubTxt('v=agenfk1; url=https://hub.acme.com')).toEqual({ url: 'https://hub.acme.com' });
  });

  it('tolerates whitespace around separators', () => {
    expect(parseHubTxt('  v = agenfk1 ;url= https://hub.acme.com ;  org =acme  '))
      .toEqual({ url: 'https://hub.acme.com', orgId: 'acme' });
  });

  it('keeps an = inside the url value', () => {
    expect(parseHubTxt('v=agenfk1; url=https://hub.acme.com/?a=b'))
      .toEqual({ url: 'https://hub.acme.com/?a=b' });
  });

  it('a record with the wrong version is not ours', () => {
    expect(parseHubTxt('v=agenfk2; url=https://hub.acme.com')).toBeNull();
  });

  it('reads the version case-insensitively', () => {
    expect(parseHubTxt('V=AGENFK1; url=https://hub.acme.com')).toEqual({ url: 'https://hub.acme.com' });
  });

  it('a record without a version is not ours', () => {
    expect(parseHubTxt('url=https://hub.acme.com; org=acme')).toBeNull();
  });

  it('a record without a url is rejected', () => {
    expect(parseHubTxt('v=agenfk1; org=acme')).toBeNull();
  });

  it('an unrelated TXT (SPF) is rejected', () => {
    expect(parseHubTxt('v=spf1 include:_spf.google.com ~all')).toBeNull();
  });
});

describe('DNS TXT source', () => {
  it('looks up _agenfk-hub.<domain of git user.email>, lowercased', async () => {
    const deps = fakeDeps({
      gitEmail: 'Dev.Person@ACME.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub.acme.com; org=acme']] },
      healthy: ['https://hub.acme.com'],
    });
    const r = await discoverHub(deps);
    expect(deps.calls.txt).toEqual([TXT_NAME]);
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'dns', orgId: 'acme' });
  });

  // A TXT answer is unauthenticated; tying the host to the email domain means
  // a spoofed record also needs a valid certificate for that domain.
  it('refuses a DNS candidate outside the email domain', async () => {
    const r = await discoverHub(fakeDeps({
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub-acme.evil.example']] },
      healthy: ['https://hub-acme.evil.example'],
    }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes('hub-acme.evil.example') && /acme\.com/.test(x))).toBe(true);
  });

  it('refuses a host that only ends with the domain text (notacme.com)', async () => {
    const r = await discoverHub(fakeDeps({
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://notacme.com']] },
      healthy: ['https://notacme.com'],
    }));
    expect(r.url).toBeNull();
  });

  it('accepts the email domain itself as well as its subdomains', async () => {
    for (const host of ['https://acme.com', 'https://afk-hub.eu.acme.com']) {
      const r = await discoverHub(fakeDeps({
        gitEmail: 'dev@acme.com',
        txt: { [TXT_NAME]: [[`v=agenfk1; url=${host}`]] },
        healthy: [host],
      }));
      expect(r).toMatchObject({ url: host, source: 'dns' });
    }
  });

  it('joins a TXT record split into 255-byte chunks before parsing', async () => {
    const r = await discoverHub(fakeDeps({
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub.ac', 'me.com; org=ac', 'me']] },
      healthy: ['https://hub.acme.com'],
    }));
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'dns', orgId: 'acme' });
  });

  it('skips a wrong-version record and uses the valid one beside it', async () => {
    const r = await discoverHub(fakeDeps({
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk2; url=https://future.example.com'], ['v=agenfk1; url=https://hub.acme.com']] },
      healthy: ['https://future.example.com', 'https://hub.acme.com'],
    }));
    expect(r).toMatchObject({ url: 'https://hub.acme.com', source: 'dns' });
  });

  it('a malformed record is reported and skipped, not thrown', async () => {
    const r = await discoverHub(fakeDeps({
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; org=acme']] },
    }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes(TXT_NAME))).toBe(true);
  });

  it('no git email: no DNS lookup at all, and the reason says so', async () => {
    const deps = fakeDeps({ gitEmail: null });
    const r = await discoverHub(deps);
    expect(deps.calls.txt).toEqual([]);
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => /git/i.test(x) && /email/i.test(x))).toBe(true);
  });

  it('a git email with no domain part does no lookup', async () => {
    const deps = fakeDeps({ gitEmail: 'localuser' });
    await discoverHub(deps);
    expect(deps.calls.txt).toEqual([]);
  });

  it('a git email lookup that throws is a reason, not a crash', async () => {
    const deps = fakeDeps();
    deps.gitEmail = async () => { throw new Error('git: command not found'); };
    const r = await discoverHub(deps);
    expect(r.url).toBeNull();
  });

  it('NXDOMAIN / ENOTFOUND falls through to "not found" with a reason', async () => {
    const r = await discoverHub(fakeDeps({ gitEmail: 'dev@acme.com', txt: {} }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes(TXT_NAME))).toBe(true);
  });
});

describe('https only', () => {
  it('the timeout constant is 3 s', () => {
    expect(DISCOVERY_TIMEOUT_MS).toBe(3000);
  });

  it.each([
    ['env', { env: { AGENFK_HUB_URL: 'http://env.example.com' }, healthy: ['http://env.example.com'] }],
    ['managed', { files: { [LINUX_MANAGED]: managed({ hubUrl: 'http://managed.example.com' }) }, healthy: ['http://managed.example.com'] }],
    ['user', { files: { [USER_FILE]: userFile('http://user.example.com') }, healthy: ['http://user.example.com'] }],
    ['dns', { gitEmail: 'dev@acme.com', txt: { [TXT_NAME]: [['v=agenfk1; url=http://dns.example.com']] }, healthy: ['http://dns.example.com'] }],
  ] as const)('an http:// candidate from %s is refused before any request', async (source, o) => {
    const deps = fakeDeps(o as any);
    const r = await discoverHub(deps);
    expect(r.url).toBeNull();
    expect(deps.calls.health).toEqual([]);
    expect(r.reasons.some(x => /https/i.test(x))).toBe(true);
    void source;
  });

  // A source that names a URL is final: falling through would let whoever can
  // take the named Hub down (or slow it past 3 s) steer the login elsewhere.
  it('an http:// candidate is refused, and the env URL that named it stops discovery', async () => {
    const deps = fakeDeps({
      env: { AGENFK_HUB_URL: 'http://env.example.com' },
      files: { [USER_FILE]: userFile('https://user.example.com') },
      healthy: ['http://env.example.com', 'https://user.example.com'],
    });
    const r = await discoverHub(deps);
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes('http://env.example.com') && /https/.test(x))).toBe(true);
    expect(deps.calls.read).not.toContain(USER_FILE);
  });

});

describe('health check: /healthz must answer service=agenfk-hub', () => {
  it('probes <url>/healthz with a timeout no longer than 3 s', async () => {
    const seen: number[] = [];
    const deps = fakeDeps({ env: { AGENFK_HUB_URL: 'https://env.example.com' }, healthy: ['https://env.example.com'] });
    const get = deps.httpGet;
    deps.httpGet = async (url, o) => { seen.push(o.timeoutMs); return get(url, o); };
    await discoverHub(deps);
    expect(deps.calls.health).toEqual(['https://env.example.com/healthz']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(3000);
  });

  it('a candidate answering another service is refused, and the managed file that named it stops discovery', async () => {
    const r = await discoverHub(fakeDeps({
      files: { [LINUX_MANAGED]: managed({ hubUrl: 'https://not-a-hub.example.com' }), [USER_FILE]: userFile('https://user.example.com') },
      healthy: ['https://user.example.com'],
    }));
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes('https://not-a-hub.example.com') && /agenfk-hub/.test(x))).toBe(true);
  });

  it('a user file whose Hub is down stops discovery instead of falling to DNS', async () => {
    const deps = fakeDeps({
      files: { [USER_FILE]: userFile('https://user.example.com') },
      gitEmail: 'dev@acme.com',
      txt: { [TXT_NAME]: [['v=agenfk1; url=https://hub.acme.com']] },
      healthy: ['https://hub.acme.com'],
    });
    const r = await discoverHub(deps);
    expect(r.url).toBeNull();
    expect(deps.calls.txt).toEqual([]);
  });

  it('a 3xx or 4xx /healthz is refused even when it claims service=agenfk-hub', async () => {
    for (const status of [302, 404]) {
      const r = await discoverHub(fakeDeps({
        env: { AGENFK_HUB_URL: 'https://env.example.com' },
        health: async () => ({ status, data: { service: 'agenfk-hub' } }),
      }));
      expect(r.url).toBeNull();
    }
  });

  it('a non-200 /healthz is refused', async () => {
    const r = await discoverHub(fakeDeps({
      env: { AGENFK_HUB_URL: 'https://env.example.com' },
      health: async () => ({ status: 503, data: { service: 'agenfk-hub' } }),
    }));
    expect(r.url).toBeNull();
  });

  it('an unreachable /healthz is refused and reported, and the env URL that named it stops discovery', async () => {
    const deps = fakeDeps({
      env: { AGENFK_HUB_URL: 'https://down.example.com' },
      files: { [USER_FILE]: userFile('https://user.example.com') },
      health: async (url) => {
        if (url.startsWith('https://down.example.com')) throw new Error('ECONNREFUSED');
        return { status: 200, data: { service: 'agenfk-hub' } };
      },
    });
    const r = await discoverHub(deps);
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes('https://down.example.com') && /ECONNREFUSED/.test(x))).toBe(true);
    expect(deps.calls.read).not.toContain(USER_FILE);
  });
});

describe('no network call blocks longer than 3 s', () => {
  it('a DNS lookup that never answers falls through after 3 s', async () => {
    vi.useFakeTimers();
    const deps = fakeDeps({ gitEmail: 'dev@acme.com', resolveTxt: () => new Promise<string[][]>(() => { /* never */ }) });
    let settled = false;
    const p = discoverHub(deps).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(settled).toBe(true);
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes(TXT_NAME) && /time(d)? ?out/i.test(x))).toBe(true);
  });

  it('a health probe that never answers is abandoned after 3 s and reported', async () => {
    vi.useFakeTimers();
    const deps = fakeDeps({
      env: { AGENFK_HUB_URL: 'https://hang.example.com' },
      health: () => new Promise(() => { /* never */ }),
    });
    let settled = false;
    const p = discoverHub(deps).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.url).toBeNull();
    expect(r.reasons.some(x => x.includes('https://hang.example.com') && /time(d)? ?out/i.test(x))).toBe(true);
  });
});
