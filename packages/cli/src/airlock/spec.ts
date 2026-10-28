/**
 * Airlock layer 2 (GH-294, L2-1): what the sandbox around a pi or OpenCode
 * session allows, built from the EFFECTIVE policy the AgEnFK server serves
 * (GET /airlock/policy: the hub's on a hub-joined installation) and the
 * session's own facts. Pure: no file system, no network, no runtime.
 *
 * Nothing here can widen the policy. Network: the policy's allow list, plus the
 * session's inference host and the local AgEnFK server on its one port; an
 * allow entry the sandbox cannot express (`*`, a CIDR range, a single-label
 * name) is left out and reported, never turned into something wider. The deny
 * side (built-in metadata hosts, policy deny, IOC hosts) always wins in the
 * runtime.
 */
import path from 'path';
import { isIPv4, isIPv6 } from 'net';
import { BUILTIN_DENY_HOSTS, HOME_CREDENTIAL_STORES, matchHost, type AirlockClient, type AirlockPolicy } from '@agenfk/core';

/** Set inside the sandbox to the client's name; the launch gate (L2-3) looks for it. */
export const AIRLOCK_SANDBOX_MARKER = 'AGENFK_AIRLOCK_SANDBOX';

export interface SandboxSession {
  client: AirlockClient;
  home: string;
  /** The directory the agent works in: writable. */
  workspace: string;
  /** Temp directories: writable. */
  tempDirs: string[];
  /** The session's inference endpoint host(s): allowed, and where a masked key is injected. */
  inferenceHosts: string[];
  /** The local AgEnFK server's port, allowed on loopback. */
  serverPort: number;
  /** Where AgEnFK is installed: never writable. */
  installDirs: string[];
  /** Project `.agenfk` directories found above the workspace: never writable. */
  projectAgenfkDirs?: string[];
  /** Env vars holding the model key: masked inside, injected by the proxy to the inference hosts. */
  maskedEnv?: string[];
  /** The sandbox runtime package itself: never writable. */
  runtimePackageDir?: string;
  /** Linux: the launcher's own network namespace (`net:[…]`), handed to the launch gate. */
  hostNetns?: string | null;
}

export interface SandboxSpec {
  network: {
    /** Host patterns (optionally `:port`) the proxy lets through. */
    allow: string[];
    /** Host patterns the proxy refuses; checked before allow. */
    deny: string[];
    /** Address ranges an allowed name may not resolve to. */
    denyResolved: string[];
  };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  maskedEnv: Array<{ name: string; injectHosts: string[] }>;
  /** Set for the sandboxed process, over the runtime's own. */
  env: Record<string, string>;
  allowPty: boolean;
  /** Entries left out because the sandbox cannot express them. */
  skipped: Array<{ entry: string; reason: string }>;
}

type Entry = { kind: 'host' | 'cidr'; value: string; reason?: undefined } | { kind: 'bad'; reason: string; value?: undefined };

/**
 * A host pattern as the runtime spells it, or why it cannot be one. A `:port`
 * suffix (an inference endpoint on its own port) is kept and restricts the
 * entry to that port.
 */
function classify(raw: string): Entry {
  const text = String(raw).trim().toLowerCase();
  const withPort = /^(\[[0-9a-f:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(text);
  if (withPort && Number(withPort[2]) >= 1 && Number(withPort[2]) <= 65535) {
    const e = classifyHost(withPort[1]);
    return e.kind === 'host' ? { kind: 'host', value: `${e.value}:${Number(withPort[2])}` } : { kind: 'bad', reason: e.reason ?? 'not a host' };
  }
  return classifyHost(text);
}

function classifyHost(raw: string): Entry {
  let h = raw;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (!h) return { kind: 'bad', reason: 'empty' };
  if (h === '*') return { kind: 'bad', reason: 'the sandbox cannot allow every host' };
  if (h.includes('/')) {
    const [addr, bits] = h.split('/');
    if ((isIPv4(addr) || isIPv6(addr)) && /^\d{1,3}$/.test(bits ?? '')) return { kind: 'cidr', value: h };
    return { kind: 'bad', reason: 'not a host' };
  }
  if (isIPv4(h)) return { kind: 'host', value: h };
  if (isIPv6(h)) return { kind: 'host', value: `[${h}]` };
  const label = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;
  const name = h.startsWith('*.') ? h.slice(2) : h;
  const labels = name.split('.');
  if (!labels.every((l) => label.test(l))) return { kind: 'bad', reason: 'not a host' };
  if (h === 'localhost') return { kind: 'host', value: h };
  // The runtime refuses single-label names and `*.tld`.
  if (labels.length < 2) return { kind: 'bad', reason: 'the sandbox cannot match a single-label name' };
  return { kind: 'host', value: h };
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** `host`, `*.host`, `1.2.3.4` or `[v6]` without any `:port`. */
function hostPart(entry: string): string {
  const m = /^(\[[^\]]+\]|[^:]+):\d+$/.exec(entry);
  return m ? m[1] : entry;
}

/** A shell env var name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildSandboxSpec(policy: AirlockPolicy, session: SandboxSession): SandboxSpec {
  const skipped: SandboxSpec['skipped'] = [];
  const home = session.home;
  const j = (...p: string[]) => path.join(...p);

  // Deny wins, decided here: the runtime dials a literal address that is
  // allowed even inside a denied range, and drops deny patterns it cannot
  // express (`*.internal`, `*.com`). Egress is allow-only, so leaving out
  // every allow a deny pattern matches is what makes the deny hold.
  const denyPatterns = [...BUILTIN_DENY_HOSTS, ...policy.hosts.deny, ...policy.iocHosts.hosts].map(String);
  // A localhost name may be answered with ANY loopback address (127.0.0.0/8,
  // ::1), and the runtime takes those answers before its range denies. So a
  // deny that touches loopback at all (a range inside it, or one covering it)
  // takes every localhost name out.
  const loopbackDeny = denyPatterns.find((d) => {
    const t = d.trim();
    if (t === '*') return true;
    const addr = t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : t;
    return matchHost(addr, ['127.0.0.0/8', '::1']) || matchHost('127.0.0.1', [t]) || matchHost('::1', [t]);
  }) ?? null;
  const deniedBy = (entry: string): string | null => {
    const host = hostPart(entry).toLowerCase();
    // The runtime takes localhost's loopback answers before any resolved-address
    // deny, so localhost and *.localhost are judged as the addresses they reach.
    const isLocalhost = host === 'localhost' || host.endsWith('.localhost');
    if (isLocalhost && loopbackDeny) return loopbackDeny;
    return denyPatterns.find((d) => d.trim() === '*' || matchHost(host, [d])) ?? null;
  };

  const allow: string[] = [];
  const addAllow = (raw: string, what = ''): boolean => {
    const e = classify(raw);
    if (e.kind !== 'host') {
      skipped.push({ entry: raw, reason: `${what}${e.reason ?? 'the sandbox cannot allow an address range'}` });
      return false;
    }
    const by = deniedBy(e.value);
    if (by) {
      skipped.push({ entry: raw, reason: `${what}denied by the policy (${by})` });
      return false;
    }
    allow.push(e.value);
    return true;
  };
  policy.hosts.allow.forEach((h) => addAllow(h));
  const inference: string[] = [];
  for (const raw of session.inferenceHosts) {
    const by = classify(raw).kind === 'host' ? deniedBy(classify(raw).value as string) : null;
    if (by) {
      throw new Error(`The session's inference host ${raw} is denied by the Airlock policy (${by}), so the session could not reach its model. Nothing was launched.`);
    }
    if (addAllow(raw, 'inference host: ')) inference.push(classify(raw).value as string);
  }
  addAllow(`127.0.0.1:${session.serverPort}`, 'the AgEnFK server: ');
  addAllow(`localhost:${session.serverPort}`, 'the AgEnFK server: ');

  const deny: string[] = [];
  const denyResolved: string[] = [];
  for (const raw of denyPatterns) {
    if (raw.trim() === '*') { deny.push('*'); continue; }
    const e = classify(raw);
    if (e.kind === 'host') deny.push(e.value);
    else if (e.kind === 'cidr') denyResolved.push(e.value);
    // The runtime cannot express this one; every allow it matches was left
    // out above, so nothing it names is reachable. Reported all the same.
    else skipped.push({ entry: raw, reason: `deny: ${e.reason ?? 'not a host'}; enforced by leaving out every allow it matches` });
  }

  const denyRead = [
    // The credential stores layer 1 also recognises (core's HOME_CREDENTIAL_STORES).
    ...HOME_CREDENTIAL_STORES.map((p) => j(home, p)),
    j(home, '.pi', 'agent', 'auth.json'),
    j(home, '.local', 'share', 'opencode', 'auth.json'),
    // Where the token the launcher's proxy reports carry lives (TEL-1), its
    // temp files included: an agent holding it could forge them. verify-token
    // stays readable: the agent's own workflow (agenfk verify, review record)
    // needs it.
    j(home, '.agenfk', 'airlock'),
  ];

  const clientState = session.client === 'pi'
    ? [j(home, '.pi', 'agent')]
    : [j(home, '.local', 'share', 'opencode'), j(home, '.local', 'state', 'opencode'), j(home, '.cache', 'opencode'), j(home, '.config', 'opencode')];
  const allowWrite = uniq([session.workspace, ...session.tempDirs, ...clientState]);

  const denyWrite = uniq([
    j(home, '.agenfk'),
    ...session.installDirs,
    j(home, '.pi', 'agent', 'extensions'),
    j(home, '.config', 'opencode', 'plugins'),
    j(home, '.config', 'opencode', 'plugin'),
    j(session.workspace, '.agenfk'),
    ...(session.projectAgenfkDirs ?? []),
    // Every .agenfk below the workspace (macOS globs; Linux applies literal paths only).
    j(session.workspace, '**', '.agenfk'),
    ...(session.runtimePackageDir ? [session.runtimePackageDir] : []),
  ]);

  const maskedEnv = (session.maskedEnv ?? []).map((name) => {
    if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not an env var name`);
    // Injection is by host name: the allow keeps the port, an inject pattern
    // with one would never match (the runtime compares names only).
    return { name, injectHosts: uniq(inference.map(hostPart)) };
  });

  return {
    network: { allow: uniq(allow), deny: uniq(deny), denyResolved: uniq(denyResolved) },
    filesystem: { denyRead, allowWrite, denyWrite },
    maskedEnv,
    env: {
      [AIRLOCK_SANDBOX_MARKER]: session.client,
      // pi and OpenCode's plugins run on Node, whose fetch() ignores the proxy
      // env without this (measured in the spike: it fails closed, inference too).
      NODE_USE_ENV_PROXY: '1',
      // The runtime sends loopback direct, which the sandbox refuses. Through
      // the proxy, loopback reaches the AgEnFK server on its one allowed port.
      NO_PROXY: '',
      no_proxy: '',
      // The gate's Linux evidence refuses a process still in this namespace.
      ...(session.hostNetns ? { AGENFK_AIRLOCK_HOST_NETNS: session.hostNetns } : {}),
    },
    // A TUI needs raw mode on its terminal: EPERM without it (measured, macOS).
    allowPty: true,
    skipped,
  };
}

/** The write root `p` sits in (or is), or null when it is outside all of them. */
export function writeRootHolding(p: string, spec: SandboxSpec): string | null {
  const target = path.resolve(p);
  for (const root of spec.filesystem.allowWrite) {
    const r = path.resolve(root);
    if (target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return root;
  }
  return null;
}
