/**
 * Airlock layer 2 (GH-294, L2-2): `agenfk airlock pi …` and
 * `agenfk airlock opencode …` start the client inside the sandbox.
 *
 *   1. The runtime says whether this machine can sandbox at all (Windows is
 *      not supported in this release; Linux needs bwrap, socat and rg).
 *   2. The EFFECTIVE policy comes from the AgEnFK server (GET /airlock/policy):
 *      on a hub-joined installation that is the hub's, and nothing local is read
 *      that could widen it. Off: refused, there is nothing to hold the session to.
 *   3. The session model gives the inference host (allowed) and the key
 *      variable (masked inside; the proxy injects the real value on the way to
 *      that host over TLS).
 *   4. The spec is built (spec.ts) and the client launched through the runtime;
 *      its exit code comes back, and SIGINT/SIGTERM/SIGHUP are passed on.
 *   5. What the sandbox proxy denies is reported to the server (proxyReport.ts,
 *      TEL-1), with a report token the sandbox cannot read:
 *      fire-and-forget, so a server that is slow or down changes nothing
 *      about the session.
 */
import os from 'os';
import path from 'path';
import { normalizeAirlockPolicy, mintAirlockSessionMarker, airlockLaunchNonce, airlockMarkerProject, type AirlockClient } from '@agenfk/core';
import { buildSandboxSpec, writeRootHolding, ENV_NAME, type SandboxSpec } from './spec';
import type { AirlockRuntime } from './runtime';
import { startServerRelay, type ServerRelay, type ServerRelayOptions } from './serverRelay';
import { ProxyDecisionReporter, type ProxyReportBody } from './proxyReport';

export class AirlockLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AirlockLaunchError';
  }
}

export interface PolicyView {
  effective: unknown;
  source?: string;
  revision?: number;
  hubManaged?: boolean;
  [k: string]: unknown;
}

export interface LaunchDeps {
  /** GET /airlock/policy: for a project (its overrides applied, PO-1), or the org's when null. */
  fetchPolicy(projectId?: string | null): Promise<PolicyView>;
  /** The AgEnFK project the workspace belongs to, or null outside one. */
  projectId?(): string | null;
  /** The directory holding that project's .agenfk, or null outside one. */
  projectRoot?(): string | null;
  /**
   * Record `root` as the project's root when the server has none, before the
   * sandbox starts: the server reads (and pins) its repository from it, which
   * picks the project's Airlock overrides. `agenfk init` sets no root.
   */
  ensureProjectRoot?(projectId: string, root: string): Promise<void>;
  runtime: AirlockRuntime;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd: string;
  tmpDir: string;
  /** The local AgEnFK server, e.g. http://localhost:3000. */
  apiUrl: string;
  /** Parsed JSON, or null when missing or unreadable. */
  readJson(file: string): unknown;
  exists(file: string): boolean;
  /** Absolute path of an executable on PATH, or null. */
  which(file: string): string | null;
  runtimePackageDir: string;
  installDirs: string[];
  log(message: string): void;
  warn(message: string): void;
  /** Subscribe to a signal; returns the unsubscribe. */
  onSignal(signal: NodeJS.Signals, handler: () => void): () => void;
  /** A directory's entries (a symlink is isLink, not isDir), or null when it cannot be read. */
  listDir(dir: string): DirEntry[] | null;
  /** The canonical path (symlinks resolved), or null when it cannot be resolved. */
  realpath(p: string): string | null;
  /** Is `p` (followed through symlinks) a directory? */
  isDirectory(p: string): boolean;
  platform: NodeJS.Platform;
  /** Linux: this process's network namespace (readlink /proc/self/ns/net), or null. */
  hostNetns?: string | null;
  /**
   * POST /airlock/proxy-decisions, sending `token` as x-agenfk-airlock-report.
   * Absent: the proxy's decisions are not reported.
   */
  postProxyDecisions?: (body: ProxyReportBody, signal: AbortSignal, token: string) => Promise<unknown>;
  /**
   * ~/.agenfk/airlock/report-token (the server makes it), read here, outside
   * the sandbox, which cannot read it, again before every batch (the server
   * may replace it mid-session). It goes only into the report's header, never
   * into the sandbox's env or argv. Null when it is missing.
   */
  reportToken?: () => string | null;
  /** Start the relay the sandbox reaches the server through (SX-1); startServerRelay unless a test hands one in. */
  startRelay?: (opts: ServerRelayOptions) => Promise<ServerRelay>;
  /**
   * Make `dir` a real 0700 directory (create it, or tighten a looser one);
   * throws when it cannot. The launcher does it for ~/.agenfk/airlock before
   * the spec is built: on Linux the sandbox masks only a denied path that
   * exists at launch, and the server may create the directory later.
   */
  ensurePrivateDir: (dir: string) => void;
}

export interface LaunchOptions {
  /** Extra env vars holding the model key, to mask. */
  keyEnv: string[];
}

/** Built-in providers: where they are served, and the env vars they take a key from. */
const PROVIDERS: Record<string, { host: string; keys: string[] }> = {
  anthropic: { host: 'api.anthropic.com', keys: ['ANTHROPIC_API_KEY'] },
  openai: { host: 'api.openai.com', keys: ['OPENAI_API_KEY'] },
  google: { host: 'generativelanguage.googleapis.com', keys: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'] },
  openrouter: { host: 'openrouter.ai', keys: ['OPENROUTER_API_KEY'] },
  groq: { host: 'api.groq.com', keys: ['GROQ_API_KEY'] },
  mistral: { host: 'api.mistral.ai', keys: ['MISTRAL_API_KEY'] },
  xai: { host: 'api.x.ai', keys: ['XAI_API_KEY'] },
  deepseek: { host: 'api.deepseek.com', keys: ['DEEPSEEK_API_KEY'] },
  cerebras: { host: 'api.cerebras.ai', keys: ['CEREBRAS_API_KEY'] },
  fireworks: { host: 'api.fireworks.ai', keys: ['FIREWORKS_API_KEY'] },
  together: { host: 'api.together.xyz', keys: ['TOGETHER_API_KEY'] },
  zai: { host: 'api.z.ai', keys: ['ZAI_API_KEY'] },
  'cloudflare-workers-ai': { host: 'api.cloudflare.com', keys: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_API_TOKEN'] },
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

/** The value of `--name v` / `--name=v` (or a short alias) in a client's argv. */
function argValue(args: string[], names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (names.includes(a)) return str(args[i + 1]);
    const eq = names.find((n) => n.startsWith('--') && a.startsWith(`${n}=`));
    if (eq) return str(a.slice(eq.length + 1));
  }
  return null;
}

interface SessionModel { provider: string | null; id: string | null }
interface Endpoint { url: string; keyEnv: string | null }

const split = (joined: string): SessionModel => {
  const slash = joined.indexOf('/');
  return slash > 0 ? { provider: joined.slice(0, slash), id: joined.slice(slash + 1) || null } : { provider: null, id: joined };
};

function piSession(args: string[], d: LaunchDeps): { model: SessionModel; endpoint: (p: string) => Endpoint | null } {
  const settings = obj(d.readJson(path.join(d.home, '.pi', 'agent', 'settings.json')));
  const models = obj(obj(d.readJson(path.join(d.home, '.pi', 'agent', 'models.json'))).providers);
  const flagModel = argValue(args, ['--model']);
  const flagProvider = argValue(args, ['--provider']);
  let model: SessionModel;
  if (flagModel && flagProvider) model = { provider: flagProvider, id: flagModel };
  else if (flagModel) model = split(flagModel);
  else model = { provider: flagProvider ?? str(settings.defaultProvider), id: str(settings.defaultModel) };
  return {
    model,
    endpoint: (provider) => {
      const p = obj(models[provider]);
      const url = str(p.baseUrl);
      if (!url) return null;
      const key = str(p.apiKey);
      return { url, keyEnv: key && ENV_NAME.test(key) ? key : null };
    },
  };
}

function opencodeSession(args: string[], d: LaunchDeps): { model: SessionModel; endpoint: (p: string) => Endpoint | null } {
  const global = obj(d.readJson(path.join(d.home, '.config', 'opencode', 'opencode.json')));
  const project = obj(d.readJson(path.join(d.cwd, 'opencode.json')));
  const providers = { ...obj(global.provider), ...obj(project.provider) };
  const joined = argValue(args, ['--model', '-m']) ?? str(project.model) ?? str(global.model);
  return {
    model: joined ? split(joined) : { provider: null, id: null },
    endpoint: (provider) => {
      const options = obj(obj(providers[provider]).options);
      const url = str(options.baseURL) ?? str(options.baseUrl);
      if (!url) return null;
      const key = str(options.apiKey);
      // opencode spells an env reference {env:NAME}
      const ref = key ? /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(key) : null;
      return { url, keyEnv: ref ? ref[1] : null };
    },
  };
}

/** `host` or `host:port` (explicit, non-default ports only), and whether the endpoint is TLS. */
function hostOf(url: string): { host: string; tls: boolean } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { host: u.port ? `${u.hostname}:${u.port}` : u.hostname, tls: u.protocol === 'https:' };
  } catch {
    return null;
  }
}

/** Directories never searched for `.agenfk`: dependencies and VCS data, not projects. */
const SCAN_SKIP = new Set(['node_modules', '.git']);
export const AGENFK_SCAN_LIMIT = 20_000;

export interface DirEntry { name: string; isDir: boolean; isLink?: boolean }
export interface ScanView {
  listDir: LaunchDeps['listDir'];
  realpath?: LaunchDeps['realpath'];
  isDirectory?: LaunchDeps['isDirectory'];
}

/**
 * Every `.agenfk` directory below `root` (not descending into one, nor into
 * node_modules or .git), breadth first, reading at most `limit` directories.
 * A `.agenfk` that is a symlink is listed as the link AND as its target, and
 * so is one found through a symlinked directory; directory symlinks are
 * followed once per canonical path, so a cycle ends. `complete` is false when
 * a directory could not be read, a link could not be resolved, or the limit
 * was hit. The runtime drops write globs on Linux, so these become literal denies.
 */
export function findAgenfkDirs(
  root: string,
  view: ScanView,
  limit: number = AGENFK_SCAN_LIMIT,
): { dirs: string[]; complete: boolean } {
  const realpath = view.realpath ?? ((p: string) => p);
  const isDirectory = view.isDirectory ?? (() => false);
  const dirs = new Set<string>();
  const found = (p: string): boolean => {
    dirs.add(p);
    const real = realpath(p);
    if (!real) return false;
    dirs.add(real);
    return true;
  };
  const rootReal = realpath(root);
  if (!rootReal) return { dirs: [], complete: false };
  const visited = new Set<string>([rootReal]);
  const queue = [root];
  let read = 0;
  let complete = true;
  while (queue.length) {
    if (read >= limit) return { dirs: [...dirs], complete: false };
    const dir = queue.shift() as string;
    read++;
    const entries = view.listDir(dir);
    if (!entries) return { dirs: [...dirs], complete: false };
    for (const e of entries) {
      if (SCAN_SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (!e.isDir && !e.isLink) continue;
      if (e.name === '.agenfk') {
        if (dir !== root || e.isLink) { if (!found(child)) complete = false; }
        continue;
      }
      if (e.isLink && !isDirectory(child)) {
        if (!realpath(child)) complete = false; // dangling, or unresolvable: cannot tell
        continue;
      }
      const real = realpath(child);
      if (!real) { complete = false; continue; }
      if (visited.has(real)) continue;
      visited.add(real);
      queue.push(child);
    }
  }
  return { dirs: [...dirs], complete };
}

/** `.agenfk` directories in the workspace and above it (not the home one, handled apart). */
/** Project `.agenfk` directories from `cwd` up (the home one aside): never writable from the sandbox. */
/** The workspace's `.git` when it is a directory (not a linked worktree's `.git` file): BUG 4639c6a4. */
export function workspaceGitDir(workspace: string, d: Pick<LaunchDeps, 'isDirectory'>): string | null {
  const dotGit = path.join(workspace, '.git');
  return d.isDirectory(dotGit) ? dotGit : null;
}

export function projectAgenfkDirs(d: Pick<LaunchDeps, 'cwd' | 'home' | 'exists'>): string[] {
  const out: string[] = [];
  let dir = path.resolve(d.cwd);
  for (;;) {
    const candidate = path.join(dir, '.agenfk');
    if (candidate !== path.join(d.home, '.agenfk') && d.exists(candidate)) out.push(candidate);
    const up = path.dirname(dir);
    if (up === dir) return out;
    dir = up;
  }
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function runAirlockLaunch(client: AirlockClient, clientArgs: string[], opts: LaunchOptions, d: LaunchDeps): Promise<number> {
  const ready = await d.runtime.check();
  if (!ready.ok) throw new AirlockLaunchError(ready.reason);
  ready.warnings.forEach((w) => d.warn(w));

  // One project for the policy and the marker (PO-1): the server judges the
  // sandbox's tool calls under the project the launch is signed for.
  const launchNonce = airlockLaunchNonce(d.projectId?.() ?? null);
  const launchProject = airlockMarkerProject(launchNonce);
  const root = d.projectRoot?.() ?? null;
  if (launchProject && root && d.ensureProjectRoot) {
    try {
      await d.ensureProjectRoot(launchProject, root);
    } catch (e) {
      // The server refuses what needs the repository it cannot tell; the rest goes on.
      d.warn(`Airlock: could not record ${root} as project ${launchProject}'s root (${(e as Error)?.message ?? e}). If your organization has per-repository overrides, set it: agenfk update-project ${launchProject} --project-root ${root}`);
    }
  }
  let view: PolicyView;
  try {
    view = await d.fetchPolicy(launchProject ?? null);
  } catch (e) {
    throw new AirlockLaunchError(
      `The AgEnFK server did not give the Airlock policy (${(e as Error)?.message ?? e}), so nothing was launched. Start it (agenfk up), or upgrade it if it predates Airlock, and retry.`,
    );
  }
  const policy = normalizeAirlockPolicy(view?.effective);
  if (policy.mode === 'off') {
    throw new AirlockLaunchError(
      'The Airlock policy is off, so there is nothing to hold this session to and nothing was launched. ' +
      (view?.hubManaged ? 'Your organization\'s hub manages it: ask an org admin.' : 'Turn it on on the board (agenfk airlock edit).'),
    );
  }

  // BUG 1a7dd9d2: a server older than this launcher runs the commands of the cards this
  // session touches (verify, the suite) on the host. Enforcing on top of that would be a
  // sandbox in name only, so it is refused; observing goes on, and says so.
  const caps = Array.isArray(view?.capabilities) ? (view.capabilities as unknown[]) : [];
  if (!caps.includes('sandboxed-commands')) {
    const older = 'The AgEnFK server running is older than this agenfk: it would run the commands of the cards this session works on (verify, the suite) outside the sandbox.';
    if (policy.mode === 'enforce') throw new AirlockLaunchError(`${older} Nothing was launched. Restart it on this version (agenfk restart), or upgrade it, and retry.`);
    d.warn(`Airlock: ${older} Restart it (agenfk restart) to sandbox them.`);
  }

  const file = d.which(client);
  if (!file) throw new AirlockLaunchError(`${client} is not installed (not found on PATH).`);

  const session = client === 'pi' ? piSession(clientArgs, d) : opencodeSession(clientArgs, d);
  const provider = session.model.provider;
  if (!provider) {
    throw new AirlockLaunchError(
      `Could not tell which model this ${client} session uses, so its inference host is unknown. ` +
      `Pass it, e.g. agenfk airlock ${client} ${client === 'pi' ? '--model' : '-m'} <provider>/<model>.`,
    );
  }
  const custom = session.endpoint(provider);
  const builtin = PROVIDERS[provider];
  const endpoint = custom ? hostOf(custom.url) : builtin ? { host: builtin.host, tls: true } : null;
  if (!endpoint) {
    throw new AirlockLaunchError(
      `Could not find the inference host for provider "${provider}": it is not a built-in provider and ${client}'s own configuration gives no endpoint for it.`,
    );
  }

  for (const name of opts.keyEnv) {
    if (!ENV_NAME.test(name)) throw new AirlockLaunchError(`--key-env ${name}: not an env var name.`);
    if (!d.env[name]) throw new AirlockLaunchError(`--key-env ${name}: that variable is not set, so there is no key to mask.`);
  }
  const keyNames = [...new Set([
    ...(custom?.keyEnv ? [custom.keyEnv] : []),
    ...(!custom && builtin ? builtin.keys : []),
    ...opts.keyEnv,
  ])].filter((n) => !!d.env[n]);
  let maskedEnv = keyNames;
  if (keyNames.length && !endpoint.tls) {
    d.warn(`${keyNames.join(', ')}: not masked, because ${endpoint.host} is plain http and the proxy injects a masked key over TLS only. The sandboxed session can read it.`);
    maskedEnv = [];
  }
  if (client === 'pi' && !maskedEnv.length) {
    d.warn('pi\'s ~/.pi/agent/auth.json is not readable inside the Airlock sandbox. Give pi its key as an env var (it is masked: the agent sees a stand-in, the proxy sends the real one to the inference host), or with --key-env NAME.');
  }

  let serverOrigin: string;
  let directServerPort: number;
  try {
    const u = new URL(d.apiUrl);
    serverOrigin = u.origin;
    directServerPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    throw new AirlockLaunchError(`The AgEnFK server address ${d.apiUrl} is not a URL.`);
  }

  const nested = findAgenfkDirs(path.resolve(d.cwd), d);
  if (!nested.complete) {
    const why = `Could not list every .agenfk directory under ${d.cwd} (a directory or symlink could not be read, or there were more than ${AGENFK_SCAN_LIMIT} to search)`;
    if (d.platform === 'linux') {
      throw new AirlockLaunchError(`${why}. On Linux each one has to be protected by name, so nothing was launched. Launch from a smaller workspace.`);
    }
    d.warn(`${why}; the sandbox's pattern deny still covers them on this platform.`);
  }

  const airlockDir = path.join(d.home, '.agenfk', 'airlock');
  try {
    d.ensurePrivateDir(airlockDir);
  } catch (e) {
    throw new AirlockLaunchError(
      `Could not make ${airlockDir} a private (0700) directory (${(e as Error)?.message ?? e}), so nothing was launched: the sandbox can only hide it from the agent if it exists at launch. Fix its ownership or permissions and retry.`,
    );
  }

  // SX-1: the sandbox reaches the AgEnFK server only through a relay in this
  // process, on a loopback port of its own: the server's port is never on the
  // sandbox's allow list. The relay marks every request it forwards (a MAC keyed
  // with the report token, read again for each request, so a token the server
  // replaces keeps marking), however the request travelled; the server reads the
  // mark to know which cards a sandboxed session touched and keeps their commands
  // in the sandbox too.
  const enforce = policy.mode === 'enforce';
  if (!str(d.reportToken?.() ?? null)) {
    if (enforce) {
      throw new AirlockLaunchError(
        '~/.agenfk/airlock/report-token is missing, so the sandbox\'s requests to the AgEnFK server cannot be marked, and the commands the server runs for this session could not be kept in the sandbox. Nothing was launched. The AgEnFK server creates it when it starts: agenfk restart.',
      );
    }
    d.warn('Airlock: ~/.agenfk/airlock/report-token is missing, so the sandbox\'s requests to the AgEnFK server are not marked (observe mode: they still go through). The AgEnFK server creates it when it starts: agenfk restart.');
  }
  const relay = await (d.startRelay ?? startServerRelay)({
    target: serverOrigin,
    marker: () => {
      const key = str(d.reportToken?.() ?? null);
      return key ? mintAirlockSessionMarker(key, launchNonce) : null;
    },
    requireMarker: enforce,
  });
  try {
    let spec: SandboxSpec;
    try {
      spec = buildSandboxSpec(policy, {
        client,
        home: d.home,
        workspace: path.resolve(d.cwd),
        tempDirs: [d.tmpDir],
        inferenceHosts: [endpoint.host],
        serverPort: relay.port,
        serverUrl: `http://${relay.host}:${relay.port}`,
        directServerPort,
        installDirs: d.installDirs,
        // A .agenfk made after launch is not a registered project; those that
        // exist now are, whatever the platform does with patterns.
        projectAgenfkDirs: [...projectAgenfkDirs(d), ...nested.dirs],
        gitDir: workspaceGitDir(path.resolve(d.cwd), d),
        maskedEnv,
        runtimePackageDir: d.runtimePackageDir,
        hostNetns: d.platform === 'linux' ? d.hostNetns ?? null : null,
      });
    } catch (e) {
      // A denied inference host: the session could not reach its model.
      throw new AirlockLaunchError((e as Error).message);
    }
    const exposed = writeRootHolding(d.runtimePackageDir, spec);
    if (exposed) {
      throw new AirlockLaunchError(
        `The sandbox runtime (${d.runtimePackageDir}) is inside ${exposed}, which the sandboxed agent may write: it could rewrite the runtime and run unsandboxed next time. ` +
        'Run agenfk from its installed copy, from a workspace that does not contain it.',
      );
    }
    for (const s of spec.skipped) d.warn(`Airlock: "${s.entry}" left out of the sandbox (${s.reason}).`);
    d.log(`Airlock: launching ${client} in the sandbox (${d.runtime.id}; policy ${policy.mode}, ${view.source ?? 'local'} revision ${view.revision ?? 0}; inference ${endpoint.host}).`);

    const post = d.postProxyDecisions;
    const token = post ? str(d.reportToken?.() ?? null) : null;
    if (post && !token) d.warn('Airlock: ~/.agenfk/airlock/report-token is missing, so the sandbox proxy\'s denials are not reported to the server (the AgEnFK server creates it when it starts: agenfk restart).');
    const reporter = post && token
      ? new ProxyDecisionReporter({
        // Read again for each batch, so a token the server replaced keeps landing.
        post: async (body, signal) => {
          const current = str(d.reportToken?.() ?? null);
          if (current) await post(body, signal, current);
        },
        client,
        model: [provider, session.model.id].filter(Boolean).join('/') || null,
        sessionId: str(d.env.AGENFK_SESSION_ID),
      })
      : null;
    const launched = await d.runtime.launch(
      spec,
      { file, args: clientArgs, cwd: path.resolve(d.cwd) },
      reporter ? { onProxyDecision: (decision) => reporter.report(decision) } : undefined,
    );
    const offs = SIGNALS.map((sig) => d.onSignal(sig, () => { launched.kill(sig); }));
    try {
      const exit = await launched.exited;
      if (exit.code !== null) return exit.code;
      return 128 + ((exit.signal && os.constants.signals[exit.signal]) || 1);
    } finally {
      offs.forEach((off) => off());
      await d.runtime.dispose();
      // The proxy has stopped: the last batch, bounded by the report timeout.
      await reporter?.close();
    }
  } finally {
    await relay.close();
  }
}
