/**
 * @vitest-environment node
 *
 * Learning with direction and wildcards (user decisions 2026-11-02):
 *  - each learned host carries how often the agent SENT data to it (an upload
 *    a tool call made; the proxy cannot see direction), shown as a hint;
 *  - hosts sharing a registrable domain are offered as one `*.domain`
 *    wildcard, never over object storage or a shared or tunnel host;
 *  - accepting picks a direction per entry.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AIRLOCK_POLICY,
  normalizeAirlockPolicy,
  hostsOfCapabilities,
  sightingsOfCapabilities,
  tallyPiSessionLine,
  mergeHostObservation,
  learningExclusionOf,
  proposeAllowlist,
  withAcceptedHosts,
  WILDCARD_REFUSED_DOMAINS,
  type AirlockLearnedHost,
  type AirlockImportTally,
} from '../airlock';

const OPEN = normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'observe' });
/** A stand-in for the public suffix list: the last two labels. */
const lastTwo = (host: string): string | null => (/^[\d.]+$/.test(host) ? null : host.split('.').slice(-2).join('.'));

const learned = (host: string, over: Partial<AirlockLearnedHost> = {}): AirlockLearnedHost => ({
  host,
  hits: { tool: 1, proxy: 0, import: 0 },
  uploads: { tool: 0, proxy: 0, import: 0 },
  firstSeen: '2026-10-27T10:00:00.000Z',
  lastSeen: '2026-10-27T11:00:00.000Z',
  receivedAt: '2026-10-27T11:00:00.000Z',
  clients: ['pi'],
  cards: [],
  ...over,
});

describe('which way a tool call sends data', () => {
  it('a host a command uploads to is an upload sighting; one it only reaches is not', () => {
    const caps = [{ kind: 'command' as const, command: 'curl -T report.csv https://up.vendor.io/in && curl -s https://docs.vendor.io/guide' }];
    expect(sightingsOfCapabilities(caps).sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'docs.vendor.io', upload: false },
      { host: 'up.vendor.io', upload: true },
    ]);
    expect(hostsOfCapabilities(caps).sort()).toEqual(['docs.vendor.io', 'up.vendor.io']);
  });

  it('a fetched URL is a download', () => {
    expect(sightingsOfCapabilities([{ kind: 'url', url: 'https://docs.vendor.io/x' }])).toEqual([{ host: 'docs.vendor.io', upload: false }]);
  });

  it('a pi session line counts uploads per host next to its hits', () => {
    const tally = new Map<string, AirlockImportTally>();
    const line = (command: string) => JSON.stringify({
      type: 'message', timestamp: '2026-10-01T09:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] },
    });
    tallyPiSessionLine(line('curl -T a.txt https://up.vendor.io/'), tally);
    tallyPiSessionLine(line('curl -s https://up.vendor.io/status'), tally);
    expect(tally.get('up.vendor.io')).toMatchObject({ hits: 2, uploads: 1 });
  });
});

describe('a learned host keeps its upload count', () => {
  const at = '2026-10-27T12:00:00.000Z';

  it('a sighting adds its upload; a plain sighting adds none', () => {
    let row = mergeHostObservation(null, { host: 'up.vendor.io', source: 'tool', client: 'pi', ts: at, receivedAt: at, uploads: 1 });
    row = mergeHostObservation(row, { host: 'up.vendor.io', source: 'tool', client: 'pi', ts: at, receivedAt: at });
    expect(row.hits.tool).toBe(2);
    expect(row.uploads).toEqual({ tool: 1, proxy: 0, import: 0 });
  });

  it('an import replaces the imported upload count, like its hits', () => {
    const imp = (hits: number, uploads: number) => ({ host: 'up.vendor.io', source: 'import' as const, client: 'pi', ts: at, receivedAt: at, hits, uploads });
    const row = mergeHostObservation(mergeHostObservation(null, imp(5, 3)), imp(5, 3));
    expect(row.uploads.import).toBe(3);
  });

  it('an upload count is never more than the hits it came with', () => {
    const row = mergeHostObservation(null, { host: 'up.vendor.io', source: 'import', client: 'pi', ts: at, receivedAt: at, hits: 2, uploads: 9 });
    expect(row.uploads.import).toBe(2);
  });

  it('a row stored before uploads were counted reads as none', () => {
    const { uploads: _u, ...old } = learned('old.vendor.io');
    const row = mergeHostObservation(old as AirlockLearnedHost, { host: 'old.vendor.io', source: 'tool', client: 'pi', ts: at, receivedAt: at, uploads: 1 });
    expect(row.uploads).toEqual({ tool: 1, proxy: 0, import: 0 });
  });

  it('the proposal says how often each host was sent data', () => {
    const p = proposeAllowlist([learned('up.vendor.io', { uploads: { tool: 2, proxy: 0, import: 1 } }), learned('docs.vendor.io')], OPEN);
    expect(p.hosts.map((h) => [h.host, h.uploads])).toEqual([['docs.vendor.io', 0], ['up.vendor.io', 3]]);
  });
});

describe('wildcard proposals', () => {
  const rows = [
    learned('api.us5.datadoghq.com', { hits: { tool: 14, proxy: 0, import: 0 } }),
    learned('mcp.us5.datadoghq.com', { hits: { tool: 6, proxy: 0, import: 0 }, uploads: { tool: 1, proxy: 0, import: 0 } }),
    learned('cglab.datadoghq.com', { hits: { tool: 6, proxy: 1, import: 0 } }),
    learned('datadoghq.com'),
    learned('docs.vendor.io'),
    learned('16.170.214.92'),
  ];

  it('hosts under one registrable domain are offered as *.domain, with what they add up to', () => {
    const p = proposeAllowlist(rows, OPEN, { registrableDomain: lastTwo });
    expect(p.wildcards).toEqual([{
      pattern: '*.datadoghq.com',
      hosts: ['cglab.datadoghq.com', 'api.us5.datadoghq.com', 'mcp.us5.datadoghq.com'],
      hits: 27, uploads: 1, evidence: 'proxy',
    }]);
    // The hosts are still offered one by one, and the bare domain (which *.domain does not match) too.
    expect(p.hosts.map((h) => h.host)).toEqual(expect.arrayContaining(['datadoghq.com', 'api.us5.datadoghq.com']));
  });

  it('one host under a domain is no wildcard; an address never is', () => {
    const p = proposeAllowlist(rows, OPEN, { registrableDomain: lastTwo });
    expect(p.wildcards.map((w) => w.pattern)).not.toContain('*.vendor.io');
  });

  it('without a registrable-domain reader there are no wildcards', () => {
    expect(proposeAllowlist(rows, OPEN).wildcards).toEqual([]);
  });

  it.each([
    [['a.us-east-1.es.amazonaws.com', 'b.us-east-1.es.amazonaws.com'], '*.amazonaws.com'],
    [['18-116-41-81.sslip.io', '44-243-79-35.sslip.io'], '*.sslip.io'],
    [['googleads.googleapis.com', 'oauth2.googleapis.com'], '*.googleapis.com'],
    [['a.blob.core.windows.net', 'openaipublic.blob.core.windows.net'], '*.windows.net'],
    [['x.ngrok-free.app', 'y.ngrok-free.app'], '*.ngrok-free.app'],
  ])('never over object storage or a shared or tunnel host: %j is not offered as %s', (hosts, pattern) => {
    const p = proposeAllowlist(hosts.map((h) => learned(h)), OPEN, { registrableDomain: lastTwo });
    expect(p.wildcards.map((w) => w.pattern)).not.toContain(pattern);
  });

  it('the refused domains are named, so the board and hub can say why', () => {
    expect(WILDCARD_REFUSED_DOMAINS).toEqual(expect.arrayContaining(['sslip.io', 'amazonaws.com', 'vercel.app']));
  });
});

describe('accepting with a direction', () => {
  it('each entry lands in the list for its direction; a bare host list is both ways, as before', () => {
    const p = withAcceptedHosts(OPEN, [
      { pattern: '*.datadoghq.com', direction: 'download' },
      { pattern: 'up.vendor.io', direction: 'upload' },
      { pattern: 'api.vendor.io', direction: 'both' },
    ]);
    expect(p.hosts).toEqual({ allow: ['api.vendor.io'], deny: [], allowDownload: ['*.datadoghq.com'], allowUpload: ['up.vendor.io'] });
    expect(withAcceptedHosts(OPEN, ['api.vendor.io']).hosts).toEqual({ allow: ['api.vendor.io'], deny: [] });
  });

  it('a host already allowed one way is already allowed: it is not proposed again', () => {
    const p = normalizeAirlockPolicy({ mode: 'observe', hosts: { allow: [], deny: [], allowDownload: ['*.datadoghq.com'] } });
    expect(learningExclusionOf('api.us5.datadoghq.com', p)).toBe('already-allowed');
  });
});

describe('review round 1 (Codex): no wildcard over any object-storage domain', () => {
  it.each([
    [['a.s3.us-south.cloud-object-storage.appdomain.cloud', 'b.s3.us-south.cloud-object-storage.appdomain.cloud'], 'appdomain.cloud'],
    [['acct1.blob.core.chinacloudapi.cn', 'acct2.blob.core.chinacloudapi.cn'], 'chinacloudapi.cn'],
    [['acct1.blob.core.usgovcloudapi.net', 'acct2.blob.core.usgovcloudapi.net'], 'usgovcloudapi.net'],
  ])('%j under %s is not offered as a wildcard', (hosts, domain) => {
    const real = (h: string) => h.split('.').slice(-2).join('.');
    const p = proposeAllowlist(hosts.map((h) => learned(h)), OPEN, { registrableDomain: real });
    expect(p.wildcards).toEqual([]);
    expect(domain).toBe(real(hosts[0]));
  });
});

describe('review round 1 (Codex): a wildcard over hosts that are not storage, under a domain storage lives in', () => {
  it('is refused: *.appdomain.cloud would reach IBM object storage too', () => {
    const real = (h: string) => h.split('.').slice(-2).join('.');
    const p = proposeAllowlist([learned('app1.us-south.cf.appdomain.cloud'), learned('app2.us-south.cf.appdomain.cloud')], OPEN, { registrableDomain: real });
    expect(p.wildcards).toEqual([]);
  });
});
