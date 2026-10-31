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
  /** The port the sandbox reaches the AgEnFK server on (the launcher's relay, SX-1), allowed on loopback. */
  serverPort: number;
  /** Where the sandbox's agenfk clients find the server (AGENFK_API_URL): the relay. */
  serverUrl?: string;
  /** The AgEnFK server's own port: never reachable from the sandbox, which goes through the relay. */
  directServerPort?: number;
  /**
   * 'client' (default): pi or OpenCode, with its own state writable and the relay to the server.
   * 'command' (SX-2): a command the server runs for a covered card - no client state, no server
   * entry, and loopback its own (bind and connect directly), so test servers work.
   */
  purpose?: 'client' | 'command';
  /** Where AgEnFK is installed: never writable. */
  installDirs: string[];
  /** Project `.agenfk` directories found above the workspace: never writable. */
  projectAgenfkDirs?: string[];
  /**
   * The workspace's own `.git`, when it is a directory (BUG 4639c6a4). The runtime
   * already keeps its config and hooks unwritable; what else git takes config from -
   * a commondir that points elsewhere, a worktree's config, the git dirs of submodules
   * and of other worktrees - is kept unwritable here, so nothing the server's git runs
   * on the host can be planted. Objects, refs and the index stay writable: commits work.
   */
  gitDir?: string | null;
  /** Env vars holding the model key: masked inside, injected by the proxy to the inference hosts. */
  maskedEnv?: string[];
  /** The sandbox runtime package itself: never writable. */
  runtimePackageDir?: string;
  /**
   * pi: its real agent dir when not ~/.pi/agent (PI_CODING_AGENT_DIR): its state is pi's, its
   * auth.json is denied and its extensions are unwritable, as ~/.pi/agent's are.
   */
  piAgentDir?: string;
}

export interface SandboxSpec {
  network: {
    /** Host patterns (optionally `:port`) the proxy lets through. */
    allow: string[];
    /** Host patterns the proxy refuses; checked before allow. */
    deny: string[];
    /** Address ranges an allowed name may not resolve to. */
    denyResolved: string[];
    /**
     * The policy's mode, for a runtime that decides each connection (smolvm): observe allows and
     * reports what enforce would refuse; the deny side holds in both.
     */
    mode?: 'observe' | 'enforce';
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
    /** The temp dirs among allowWrite: a runtime with its own file system (a VM) gives the guest its own instead. */
    privateTemp?: string[];
  };
  /** The folder the session was launched from: a runtime that keeps a machine keeps one per workspace. */
  workspace?: string;
  /** The user's home, at the same path inside a runtime that mounts. */
  home?: string;
  /** The image a runtime that keeps a machine makes it from (CGLAB-696; image.ts): the launcher sets it. */
  machineImage?: string;
  /** A client's relay to the AgEnFK server (SX-1), on the host loopback: a machine reaches it through its decider. */
  relayPort?: number;
  /**
   * Inference endpoints on the host's own loopback (an ssh tunnel, ollama), as allowed: a machine's
   * loopback is its own, so a runtime that keeps one routes these through its decider to the host.
   */
  loopbackInference?: Array<{ host: string; port: number }>;
  maskedEnv: Array<{ name: string; injectHosts: string[] }>;
  /**
   * Host env vars the session gets as they are: a key for a plain-http inference endpoint, which no
   * injector can mask (story review 3). Names only; the runtime reads the values from the host.
   */
  plainEnv?: string[];
  /** Set for the sandboxed process, over the runtime's own. */
  env: Record<string, string>;
  allowPty: boolean;
  /** Entries left out because the sandbox cannot express them. */
  skipped: Array<{ entry: string; reason: string }>;
  /** A command's sandbox (SX-2): it may bind loopback ports, so its test servers run. */
  allowLocalBinding?: boolean;
  /** What the sandbox runs (SandboxSession.purpose): a runtime that keeps a machine runs a command beside a client. */
  purpose?: 'client' | 'command';
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

/**
 * Would allowing `entry` let the sandbox reach the AgEnFK server directly, past
 * the relay (SX-1)? Loopback on every port does, and so does loopback on the
 * server's own port.
 */
function reachesServerDirectly(entry: string, directPort: number | undefined): boolean {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
  if (!m) return false;
  // As the resolver reads it: the URL parser turns 127.1 and 2130706433 into
  // 127.0.0.1; matchHost reads mapped and expanded IPv6.
  let host = m[1];
  try {
    host = new URL(`http://${host}/`).hostname;
  } catch {
    return false;
  }
  if (!matchHost(host.replace(/^\[|\]$/g, ''), LOOPBACK)) return false;
  return m[2] === undefined || (directPort !== undefined && Number(m[2]) === directPort);
}

/** Every way to name this machine: loopback, the unspecified addresses, localhost names. */
const LOOPBACK = ['127.0.0.0/8', '::1', '0.0.0.0', '::', 'localhost', '*.localhost'];

const DIRECT_SERVER = 'it would let the sandbox reach the AgEnFK server directly, past the Airlock relay';

/** A command's loopback, sent direct rather than to the proxy (SX-2). */
const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1';

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
  const addAllow = (raw: string, what = '', relayEntry = false): boolean => {
    const e = classify(raw);
    if (e.kind !== 'host') {
      skipped.push({ entry: raw, reason: `${what}${e.reason ?? 'the sandbox cannot allow an address range'}` });
      return false;
    }
    if (!relayEntry && reachesServerDirectly(e.value, session.directServerPort)) {
      skipped.push({ entry: raw, reason: `${what}${DIRECT_SERVER}` });
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
    const c = classify(raw);
    if (c.kind === 'host' && reachesServerDirectly(c.value, session.directServerPort)) {
      throw new Error(`The session's inference host ${raw} is not allowed: ${DIRECT_SERVER}. Give the endpoint its own port. Nothing was launched.`);
    }
    const by = classify(raw).kind === 'host' ? deniedBy(classify(raw).value as string) : null;
    if (by) {
      throw new Error(`The session's inference host ${raw} is denied by the Airlock policy (${by}), so the session could not reach its model. Nothing was launched.`);
    }
    if (addAllow(raw, 'inference host: ')) inference.push(classify(raw).value as string);
  }
  // The machine reaches the host loopback over IPv4 alone (its gateway): `localhost` and 127.x are
  // routed, an IPv6 or unspecified address cannot be.
  const loopbackInference: Array<{ host: string; port: number }> = [];
  for (const e of inference) {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(e);
    if (!m || !matchHost(m[1].replace(/^\[|\]$/g, ''), LOOPBACK)) continue;
    if (m[1].startsWith('[') || m[1] === '0.0.0.0') {
      skipped.push({ entry: e, reason: 'inference host: the machine reaches the host loopback over IPv4 only; name the endpoint 127.0.0.1 or localhost' });
      continue;
    }
    loopbackInference.push({ host: m[1], port: Number(m[2]) });
  }
  // A command the server runs does not talk to the server (SX-2); a client does, through the relay.
  if (session.purpose !== 'command') {
    addAllow(`127.0.0.1:${session.serverPort}`, 'the AgEnFK server: ', true);
    addAllow(`localhost:${session.serverPort}`, 'the AgEnFK server: ', true);
  }

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
    ...(session.piAgentDir ? [j(session.piAgentDir, 'auth.json')] : []),
    j(home, '.local', 'share', 'opencode', 'auth.json'),
    // Where the token the launcher's proxy reports carry lives (TEL-1), its
    // temp files included: an agent holding it could forge them. verify-token
    // stays readable: the agent's own workflow (agenfk verify, review record)
    // needs it.
    j(home, '.agenfk', 'airlock'),
    // A command the server runs needs no agenfk token (SX-3 review): it could only use it against the server.
    ...(session.purpose === 'command' ? [j(home, '.agenfk', 'verify-token')] : []),
  ];

  const command = session.purpose === 'command';
  const clientState = command ? [] : session.client === 'pi'
    ? [session.piAgentDir ?? j(home, '.pi', 'agent')]
    : [j(home, '.local', 'share', 'opencode'), j(home, '.local', 'state', 'opencode'), j(home, '.cache', 'opencode'), j(home, '.config', 'opencode')];
  const allowWrite = uniq([session.workspace, ...session.tempDirs, ...clientState]);

  // What the host runs next from a client's own state (story review 3): pi's launcher, its installed
  // releases and packages and the settings that name packages to load; OpenCode's config (MCP
  // commands, plugins), the LSP binaries and the plugin packages it installs. The rest of that
  // state (sessions, models.json) stays writable.
  const piHostCode = (dir: string) => ['extensions', 'bin', 'install', 'npm', 'git', 'settings.json'].map((p) => j(dir, p));
  const denyWrite = uniq([
    j(home, '.agenfk'),
    ...session.installDirs,
    ...piHostCode(j(home, '.pi', 'agent')),
    ...(session.piAgentDir ? piHostCode(session.piAgentDir) : []),
    j(home, '.config', 'opencode', 'plugins'),
    j(home, '.config', 'opencode', 'plugin'),
    // (OpenCode installs plugin packages into its config dir too.)
    ...['opencode.json', 'opencode.jsonc', 'config.json', 'node_modules', 'package.json'].map((f) => j(home, '.config', 'opencode', f)),
    j(home, '.local', 'share', 'opencode', 'bin'),
    j(home, '.cache', 'opencode', 'node_modules'),
    j(home, '.cache', 'opencode', 'package.json'),
    j(session.workspace, '.agenfk'),
    ...(session.projectAgenfkDirs ?? []),
    ...(session.gitDir ? ['commondir', 'config.worktree', 'modules', 'worktrees'].map((n) => j(session.gitDir!, n)) : []),
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
    network: { allow: uniq(allow), deny: uniq(deny), denyResolved: uniq(denyResolved), mode: policy.mode === 'observe' ? 'observe' : 'enforce' },
    filesystem: { denyRead, allowWrite, denyWrite, privateTemp: uniq(session.tempDirs) },
    workspace: session.workspace,
    home,
    ...(command ? {} : { relayPort: session.serverPort }),
    loopbackInference,
    maskedEnv,
    env: {
      [AIRLOCK_SANDBOX_MARKER]: command ? 'command' : session.client,
      // pi and OpenCode's plugins run on Node, whose fetch() ignores the proxy
      // env without this (measured in the spike: it fails closed, inference too).
      NODE_USE_ENV_PROXY: '1',
      // The runtime sends loopback direct, which the sandbox refuses. Through
      // the proxy, loopback reaches the AgEnFK server on its one allowed port.
      // A command's own loopback (its test servers) goes direct: allowLocalBinding below.
      NO_PROXY: command ? LOCAL_NO_PROXY : '',
      no_proxy: command ? LOCAL_NO_PROXY : '',
      // Every agenfk client inside (CLI, hooks, the pi and OpenCode adapters) reads it first.
      ...(session.serverUrl ? { AGENFK_API_URL: session.serverUrl } : {}),
      // The agent dir the user chose, by its resolved path (the machine does not see the host's env).
      ...(!command && session.client === 'pi' && session.piAgentDir ? { PI_CODING_AGENT_DIR: session.piAgentDir } : {}),
    },
    // A TUI needs raw mode on its terminal: EPERM without it (measured, macOS).
    allowPty: true,
    skipped,
    ...(command ? { allowLocalBinding: true } : {}),
    purpose: command ? 'command' : 'client',
  };
}

/**
 * The shared /tmp by its real path (/private/tmp on macOS), writable inside the sandbox as the
 * temp dir is (BUG 38d7231e): tools that hardcode /tmp failed with EPERM where only
 * os.tmpdir() was. None on Windows.
 *
 * ACCEPTED RISK (user decision 2026-10-28, after the security review): the sandbox can modify
 * anything of the user's under /tmp - a git checkout's hooks there run unsandboxed on the next
 * host commit, other tools' scratch files are writable. That was ASRT's limit (no private /tmp on
 * macOS); smolvm mounts no host temp dir (privateTemp), so in a machine the guest's /tmp is its own.
 */
export function sharedTempDir(platform: NodeJS.Platform, realpath: (p: string) => string | null): string | null {
  return platform === 'win32' ? null : realpath('/tmp');
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
