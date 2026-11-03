/**
 * @vitest-environment node
 *
 * What a person sees next to a learned host, to decide on it (user decisions
 * 2026-11-02): the projects whose sessions reached it, an address's reverse
 * DNS name, exact labels (a public DNS resolver, a cloud machine, an address
 * with no name, a network address), and - only when the import was asked for
 * one - a model-written sentence. Display only: none of it decides anything.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AIRLOCK_POLICY,
  normalizeAirlockPolicy,
  hostLabels,
  sanitizeHostContext,
  mergeHostObservation,
  proposeAllowlist,
  tallyPiSessionLine,
  MAX_CONTEXT_PROJECTS,
  MAX_HINT_CHARS,
  type AirlockHostContext,
  type AirlockImportTally,
} from '../airlock';

const ctx = (over: Partial<AirlockHostContext> = {}): AirlockHostContext => ({ projects: [], reverseDns: null, hint: null, hintBy: null, ...over });

describe('labels, from the host and its reverse DNS name alone', () => {
  it.each([
    ['1.1.1.1', null, ['public-dns-resolver']],
    ['8.8.8.8', 'dns.google', ['public-dns-resolver']],
    ['208.67.222.222', null, ['public-dns-resolver']],
    ['dns.google', null, ['public-dns-resolver']],
    ['16.170.214.92', 'ec2-16-170-214-92.eu-north-1.compute.amazonaws.com', ['cloud-machine']],
    ['54.196.243.136', 'ec2-54-196-243-136.compute-1.amazonaws.com', ['cloud-machine']],
    ['34.1.2.3', '3.2.1.34.bc.googleusercontent.com', ['cloud-machine']],
    ['ec2-54-1-2-3.compute-1.amazonaws.com', null, ['cloud-machine']],
    ['52.1.2.3', null, ['unnamed-address']],
    ['154.0.0.0', null, ['network-address', 'unnamed-address']],
    ['api.vendor.io', null, []],
    ['203.0.113.7', 'mail.vendor.io', []],
  ] as const)('%s (reverse DNS %s) is labelled %j', (host, reverseDns, labels) => {
    expect(hostLabels(host, ctx({ reverseDns }))).toEqual(labels);
  });

  it('with no context an address has no name to go by', () => {
    expect(hostLabels('52.1.2.3')).toEqual(['unnamed-address']);
    expect(hostLabels('api.vendor.io', null)).toEqual([]);
  });
});

describe('a context as it may be kept', () => {
  it('keeps projects, a reverse DNS name that is a host, one line of hint and who wrote it', () => {
    expect(sanitizeHostContext({
      projects: ['spark', 'spark', 'horizon-lab'], reverseDns: 'EC2-1-2-3-4.compute-1.amazonaws.com',
      hint: '  A cloud machine;\n agents polled\tits status.  ', hintBy: 'claude', extra: 'never read',
    })).toEqual({
      projects: ['spark', 'horizon-lab'], reverseDns: 'ec2-1-2-3-4.compute-1.amazonaws.com',
      hint: 'A cloud machine; agents polled its status.', hintBy: 'claude',
    });
  });

  it('drops what is not what it claims to be', () => {
    expect(sanitizeHostContext({ projects: 'spark', reverseDns: 'https://x.vendor.io/path', hint: 42, hintBy: ['x'] })).toBeNull();
    expect(sanitizeHostContext({ projects: [7, '', 'a\u0000b', 'x'.repeat(65), 'ok'] })).toEqual(ctx({ projects: ['ok'] }));
    expect(sanitizeHostContext(null)).toBeNull();
    expect(sanitizeHostContext('spark')).toBeNull();
  });

  it('is bounded: projects, and the hint cut to its limit', () => {
    const got = sanitizeHostContext({ projects: Array.from({ length: 20 }, (_, i) => `p${i}`), hint: 'h'.repeat(1000), hintBy: 'b'.repeat(200) })!;
    expect(got.projects).toHaveLength(MAX_CONTEXT_PROJECTS);
    expect(got.hint!.length).toBeLessThanOrEqual(MAX_HINT_CHARS);
    expect(got.hintBy).toBeNull();
  });

  it('a field the screen says carries a secret is dropped, the rest kept', () => {
    const screen = (s: string) => s.includes('SECRET');
    expect(sanitizeHostContext({ projects: ['ok', 'SECRET-proj'], hint: 'token SECRET here', reverseDns: 'a.vendor.io' }, screen))
      .toEqual(ctx({ projects: ['ok'], reverseDns: 'a.vendor.io' }));
  });
});

describe('a learned host keeps the context its latest import brought', () => {
  const at = '2026-11-02T12:00:00.000Z';
  const imp = (context?: AirlockHostContext) => ({ host: 'api.vendor.io', source: 'import' as const, client: 'pi', ts: at, receivedAt: at, hits: 2, context });

  it('an import replaces the projects and the reverse DNS name', () => {
    let row = mergeHostObservation(null, imp(ctx({ projects: ['a'], reverseDns: 'x.vendor.io' })));
    row = mergeHostObservation(row, imp(ctx({ projects: ['b'] })));
    expect(row.context).toEqual(ctx({ projects: ['b'] }));
  });

  it('an import without a hint keeps the earlier hint; one with a hint replaces it', () => {
    let row = mergeHostObservation(null, imp(ctx({ hint: 'first', hintBy: 'pi' })));
    row = mergeHostObservation(row, imp(ctx({ projects: ['a'] })));
    expect(row.context).toEqual(ctx({ projects: ['a'], hint: 'first', hintBy: 'pi' }));
    row = mergeHostObservation(row, imp(ctx({ hint: 'second', hintBy: 'claude' })));
    expect(row.context).toMatchObject({ hint: 'second', hintBy: 'claude' });
  });

  it('a tool sighting leaves the context as it was', () => {
    const row = mergeHostObservation(mergeHostObservation(null, imp(ctx({ projects: ['a'] }))), { host: 'api.vendor.io', source: 'tool', client: 'pi', ts: at, receivedAt: at });
    expect(row.context).toEqual(ctx({ projects: ['a'] }));
  });
});

describe('the proposal carries each host\'s context and labels', () => {
  it('as learned, labels computed from it', () => {
    const open = normalizeAirlockPolicy({ ...DEFAULT_AIRLOCK_POLICY, mode: 'observe' });
    const at = '2026-11-02T12:00:00.000Z';
    const row = mergeHostObservation(null, {
      host: '16.170.214.92', source: 'import', client: 'pi', ts: at, receivedAt: at, hits: 3,
      context: ctx({ projects: ['horizon'], reverseDns: 'ec2-16-170-214-92.eu-north-1.compute.amazonaws.com', hint: 'A build box.', hintBy: 'pi' }),
    });
    const plain = mergeHostObservation(null, { host: 'api.vendor.io', source: 'tool', client: 'pi', ts: at, receivedAt: at });
    const p = proposeAllowlist([row, plain], open);
    expect(p.hosts.find((h) => h.host === '16.170.214.92')).toMatchObject({ context: row.context, labels: ['cloud-machine'] });
    expect(p.hosts.find((h) => h.host === 'api.vendor.io')).toMatchObject({ context: null, labels: [] });
  });
});

describe('the import sees each tool call with its hosts, for a hint\'s examples', () => {
  it('one call per tool call, with its command and the hosts it reached', () => {
    const line = JSON.stringify({
      type: 'message', timestamp: '2026-10-01T09:00:00.000Z',
      message: { role: 'assistant', content: [
        { type: 'toolCall', name: 'bash', arguments: { command: 'curl -s https://api.vendor.io/v1 && ssh 52.1.2.3 uptime' } },
        { type: 'toolCall', name: 'fetch', arguments: { url: 'https://docs.vendor.io/guide' } },
        { type: 'text', text: 'see https://said.vendor.io' },
      ] },
    });
    const calls: Array<{ hosts: string[]; text: string }> = [];
    tallyPiSessionLine(line, new Map<string, AirlockImportTally>(), { onCall: (c) => calls.push({ ...c, hosts: [...c.hosts].sort() }) });
    expect(calls).toEqual([
      { hosts: ['52.1.2.3', 'api.vendor.io'], text: 'curl -s https://api.vendor.io/v1 && ssh 52.1.2.3 uptime' },
      { hosts: ['docs.vendor.io'], text: 'https://docs.vendor.io/guide' },
    ]);
  });

  it('a call that reached no host is not reported', () => {
    const calls: unknown[] = [];
    const line = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls -la' } }] } });
    tallyPiSessionLine(line, new Map(), { onCall: (c) => calls.push(c) });
    expect(calls).toEqual([]);
  });
});

describe('review (Codex, 2026-11-02): a secret is judged before the text is lowercased or cut', () => {
  const awsKey = (s: string) => /AKIA[0-9A-Z]{16}/.test(s);
  const ghToken = (s: string) => /ghp_[A-Za-z0-9]{36}/.test(s);

  it('a reverse DNS name holding an uppercase key id is dropped, though lowercased it would pass', () => {
    expect(sanitizeHostContext({ projects: ['p'], reverseDns: 'AKIAIOSFODNN7EXAMPLE.vendor.io' }, awsKey)).toEqual(ctx({ projects: ['p'] }));
  });

  it('a hint whose token straddles the cut is dropped, not kept with the token\'s head', () => {
    const hint = `${'w'.repeat(MAX_HINT_CHARS - 40)} ghp_${'a'.repeat(36)} tail`;
    expect(sanitizeHostContext({ projects: ['p'], hint, hintBy: 'pi' }, ghToken)).toEqual(ctx({ projects: ['p'] }));
  });
});
