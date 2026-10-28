/**
 * Reads a shell command string for what it can reach. This is a TRIPWIRE, not a
 * boundary: obfuscation, interpreters and scripts written to disk get past it.
 * The egress proxy (layer 2) is the boundary.
 *
 * Words are judged in COMMAND POSITION — first word of each simple command, after
 * assignments and wrappers (sudo, env, xargs, nohup, timeout...) — so
 * `echo unshare` is not `unshare`. `sh -c '...'`, `eval`, `$(...)` and backticks
 * are read as commands too.
 */
import { posix } from 'node:path';
import { hostFromTarget, hostFromUrl } from './hosts';

export interface UploadFact {
  tool: string;
  /** where the data goes; UNKNOWN_HOST stands for a destination that cannot be read */
  hosts: string[];
}

export interface CommandAnalysis {
  /** command names in command position */
  commands: string[];
  /** every host the command connects to or names, in order of appearance */
  hosts: string[];
  uploads: UploadFact[];
  /** can it reach the network at all */
  network: boolean;
  credentialPaths: string[];
  namespaceEscape: string | null;
  /** e.g. `aws s3 rm`; null when no mutating cloud verb */
  cloudMutation: string | null;
}

type Tok = { t: 'w'; v: string } | { t: 'op'; v: string } | { t: 'redir'; v: string };

interface Simple {
  words: string[];
  redirs: { op: string; target: string }[];
  /** its stdin comes from a pipe */
  piped: boolean;
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

/** Index just past the `)` that closes the `(` at src[open]. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\' && quote === '"') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') j++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j + 1;
  }
  return src.length;
}

function closeBacktick(src: string, open: number): number {
  for (let j = open + 1; j < src.length; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === '`') return j + 1;
  }
  return src.length;
}

const OPERATOR = /^(?:&&|\|\||\|&|;;|\||;|&|\(|\))/;
const REDIRECT = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)/;

/**
 * Splits a command into words, operators and redirections. Substitutions
 * (`$(...)`, backticks, `<(...)`) stay inside their word and are also pushed to
 * `subs` to be read as commands of their own.
 */
function tokenize(src: string, subs: string[]): Tok[] {
  const out: Tok[] = [];
  let cur = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) out.push({ t: 'w', v: cur });
    cur = '';
    inWord = false;
  };
  const substitution = (start: number, bodyFrom: number, end: number) => {
    subs.push(src.slice(bodyFrom, end - 1));
    cur += src.slice(start, end);
    inWord = true;
    return end;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\n') {
      endWord();
      out.push({ t: 'op', v: ';' });
      i++;
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\\') {
      if (next !== '\n' && next !== undefined) {
        cur += next;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close;
      cur += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1])) {
          cur += src[i + 1];
          i += 2;
        } else if (src[i] === '$' && src[i + 1] === '(') {
          i = substitution(i, i + 2, closeParen(src, i + 1));
        } else if (src[i] === '`') {
          i = substitution(i, i + 1, closeBacktick(src, i));
        } else {
          cur += src[i++];
        }
      }
      i++;
    } else if (c === '$' && next === '(') {
      i = substitution(i, i + 2, closeParen(src, i + 1));
    } else if (c === '`') {
      i = substitution(i, i + 1, closeBacktick(src, i));
    } else if ((c === '<' || c === '>') && next === '(') {
      i = substitution(i, i + 2, closeParen(src, i + 1));
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      if (inWord && /^\d+$/.test(cur)) {
        cur = '';
        inWord = false; // a file descriptor number, not a word
      } else endWord();
      const op = REDIRECT.exec(src.slice(i))![0];
      out.push({ t: 'redir', v: op });
      i += op.length;
    } else {
      const op = OPERATOR.exec(src.slice(i));
      if (op) {
        endWord();
        out.push({ t: 'op', v: op[0] });
        i += op[0].length;
      } else {
        cur += c;
        inWord = true;
        i++;
      }
    }
  }
  endWord();
  return out;
}

function simpleCommands(toks: Tok[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirs: [], piped: false };
  const finish = (piped: boolean) => {
    if (cur.words.length || cur.redirs.length) out.push(cur);
    cur = { words: [], redirs: [], piped };
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (tok.t === 'w') cur.words.push(tok.v);
    else if (tok.t === 'redir') {
      const target = toks[i + 1];
      if (target?.t === 'w') {
        cur.redirs.push({ op: tok.v, target: target.v });
        i++;
      } else cur.redirs.push({ op: tok.v, target: '' });
    } else finish(tok.v === '|' || tok.v === '|&');
  }
  finish(false);
  return out;
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

interface Opt {
  name: string;
  value: string | null;
  /** index in args of the word holding the value (the option word itself when attached); -1 when none */
  at: number;
}

interface Parsed {
  positionals: string[];
  opts: Opt[];
}

/**
 * getopt-style parse: `valueOpts` names the options that take a value
 * (`-o out`, `-oout`, `--output out`, `--output=out`).
 */
function parseArgs(args: string[], valueOpts: ReadonlySet<string>): Parsed {
  const positionals: string[] = [];
  const opts: Opt[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opts.push({ name: a.slice(0, eq), value: a.slice(eq + 1), at: i });
      else if (valueOpts.has(a)) {
        i++;
        opts.push({ name: a, value: args[i] ?? '', at: i });
      } else opts.push({ name: a, value: null, at: -1 });
    } else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const name = `-${a[k]}`;
        if (valueOpts.has(name)) {
          const attached = a.slice(k + 1);
          if (attached) opts.push({ name, value: attached, at: i });
          else {
            i++;
            opts.push({ name, value: args[i] ?? '', at: i });
          }
          break;
        }
        opts.push({ name, value: null, at: -1 });
      }
    } else positionals.push(a);
  }
  return { positionals, opts };
}

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

function basename(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash >= 0 ? word.slice(slash + 1) : word;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KEYWORDS = set('if then else elif fi do done while until for in case esac ! { }');

/** Wrappers that run the command after them; values are the options that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: set('-u -g -h -p -C -D -r -t -U -T --user --group --host --prompt --chdir --role --type --other-user'),
  doas: set('-u -C'),
  env: set('-u -C -S --unset --chdir --split-string'),
  xargs: set('-I -n -P -L -d -E -s -a --arg-file --delimiter --max-args --max-procs --max-lines --replace'),
  nohup: set(''),
  exec: set('-a'),
  command: set(''),
  builtin: set(''),
  nice: set('-n --adjustment'),
  ionice: set('-c -n -p'),
  stdbuf: set('-i -o -e'),
  setsid: set(''),
  timeout: set('-s -k --signal --kill-after'),
  chroot: set('--userspec --groups'),
  time: set('-f --format -o --output'),
};

/** Wrappers whose first positional is an argument, not the command (`timeout 5 cmd`). */
const WRAPPER_POSITIONALS: Record<string, number> = { timeout: 1, chroot: 1 };

type Resolved =
  /** `args` are words[offset..] */
  | { name: string; args: string[]; offset: number }
  /** `env -S 'cmd args'`: a command string to read on its own */
  | { split: string };

/** The command a simple command runs, after assignments and wrappers. */
function commandOf(words: string[]): Resolved | null {
  let i = 0;
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i]) || KEYWORDS.has(words[i]))) i++;
    if (i >= words.length) return null;
    const name = basename(words[i]);
    const valueOpts = WRAPPERS[name];
    if (!valueOpts) return { name, args: words.slice(i + 1), offset: i + 1 };
    i++;
    let split: string | null = null;
    while (i < words.length && words[i].startsWith('-') && words[i].length > 1) {
      const w = words[i++];
      if (w === '--') break;
      if (name === 'env' && (w === '-S' || w === '--split-string')) split = words[i++] ?? '';
      else if (name === 'env' && w.startsWith('--split-string=')) split = w.slice('--split-string='.length);
      else if (name === 'env' && /^-S./.test(w)) split = w.slice(2);
      else if (valueOpts.has(w)) i++;
    }
    if (split !== null) return { split: [split, ...words.slice(i)].join(' ') };
    i += WRAPPER_POSITIONALS[name] ?? 0;
  }
}

// ---------------------------------------------------------------------------
// network tools
// ---------------------------------------------------------------------------

/** An upload destination that cannot be read (a variable, a substitution). */
export const UNKNOWN_HOST = '(unknown host)';

interface NetResult {
  /** every host the tool connects to */
  contacted: string[];
  /** where data is sent; null when the command sends nothing */
  destinations: string[] | null;
  /** indices in args of words the command WRITES to (output files) */
  outputs: number[];
}

const CURL_VALUES = set(`-T --upload-file -d --data --data-binary --data-raw --data-ascii --data-urlencode
  -F --form --form-string --json -o --output -H --header -u --user -A --user-agent -e --referer -b --cookie
  -c --cookie-jar -K --config -X --request -w --write-out --cacert --capath --cert -E --key --key-type
  --cert-type -m --max-time --connect-timeout -r --range -z --time-cond -x --proxy -U --proxy-user --resolve
  --connect-to --interface --dns-servers -C --continue-at --retry --retry-delay --retry-max-time
  --limit-rate -Y --speed-limit -y --speed-time --max-filesize --url -t --telnet-option -Q --quote
  --trace --trace-ascii --stderr -D --dump-header --variable --preproxy --socks4 --socks4a --socks5
  --socks5-hostname --proxy-header --output-dir --etag-save --etag-compare --libcurl --noproxy`);
const CURL_UPLOADS = set(`-T --upload-file -d --data --data-binary --data-raw --data-ascii --data-urlencode
  -F --form --form-string --json`);
const CURL_OUTPUTS = set(`-o --output -D --dump-header -c --cookie-jar --stderr --trace --trace-ascii
  --etag-save --libcurl --output-dir`);
const CURL_PROXIES = set('-x --proxy --preproxy --socks4 --socks4a --socks5 --socks5-hostname');
const WGET_VALUES = set(`-O --output-document -o --output-file -a --append-output -P --directory-prefix
  -U --user-agent --header -e --execute -t --tries -T --timeout -w --wait --user --password -i --input-file
  -B --base -l --level -A -R -D -I -X --post-data --post-file --body-data --body-file --method --referer
  --load-cookies --save-cookies -Q --quota --limit-rate`);
const WGET_UPLOADS = set('--post-data --post-file --body-data --body-file');
const WGET_OUTPUTS = set(`-O --output-document -o --output-file -a --append-output -P --directory-prefix
  --save-cookies`);
const NC_VALUES = set('-p -s -w -i -q -x -X -e -c -I -O -T -V -M -m -P');
const SSH_VALUES = set('-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w -B');
const SCP_VALUES = set('-c -D -F -i -J -l -o -P -S -X');
const SFTP_VALUES = set('-B -b -c -D -F -i -J -l -o -P -R -S -s -X');
const RSYNC_VALUES = set(`-e --rsh --exclude --include --filter -f --port --password-file --log-file -B
  --block-size -T --temp-dir --partial-dir --chmod --chown --timeout --contimeout --address -M
  --remote-option --rsync-path --exclude-from --include-from --files-from --compare-dest --copy-dest
  --link-dest --backup-dir --suffix --max-size --min-size --bwlimit --out-format --info --debug`);

/** `[user@]host:path` (scp, rsync, sftp) or `host::module` (rsync). */
function remoteHost(arg: string): string | null {
  if (arg.includes('://')) return hostFromUrl(arg);
  const m = /^((?:[^@/:\s]+@)?(?:\[[^\]]+\]|[^:/\s@]+)):/.exec(arg);
  return m ? hostFromTarget(m[1], true) : null;
}

/** A path argument that is plainly on this machine, even with a variable in it. */
const LOCAL_PATH = /^(?:\/|\.{1,2}(?:\/|$)|~|\$\{?(?:HOME|PWD|TMPDIR)\}?(?:\/|$))/;

/**
 * Where an scp/rsync operand lives: a remote host, a remote we cannot read
 * (`"$USER@$HOST:/tmp"`, or a bare `"$DEST"` that may well be one), or null
 * when it is on this machine.
 */
function operandHost(arg: string): string | null {
  const host = remoteHost(arg);
  if (host) return host;
  if (LOCAL_PATH.test(arg)) return null;
  const colon = arg.indexOf(':');
  const slash = arg.indexOf('/');
  if (colon > 0 && (slash < 0 || colon < slash)) return UNKNOWN_HOST;
  return /[$`]/.test(arg) ? UNKNOWN_HOST : null;
}

/** Does the command read stdin from a pipe, a file or a here-string? */
function fedInput(s: Simple): boolean {
  return s.piped || s.redirs.some((r) => r.op.startsWith('<') && r.op !== '<&');
}

const compact = (xs: (string | null)[]): string[] => xs.filter((x): x is string => !!x);

/**
 * The hosts curl actually dials instead of (or on the way to) its URLs: proxies,
 * `--resolve [+]host:port:addr[,addr]` and `--connect-to h1:p1:h2:p2`.
 * A value that is set but cannot be read (`"$PROXY"`) is UNKNOWN_HOST; an empty
 * value (`--proxy ""`, `--connect-to h:p::p2`) overrides nothing.
 */
function curlOverrideHosts(opt: Opt): string[] {
  const v = (opt.value ?? '').trim();
  const read = (h: string) => hostFromTarget(h, true) ?? UNKNOWN_HOST;
  if (opt.name === '--resolve') {
    const m = /^\+?[^:]*:[^:]*:(.*)$/.exec(v);
    if (!m) return v ? [UNKNOWN_HOST] : [];
    return m[1].split(',').map((a) => a.trim()).filter(Boolean).map(read);
  }
  if (opt.name === '--connect-to') {
    const m = /^(?:\[[^\]]*\]|[^:]*):[^:]*:(\[[^\]]*\]|[^:]*)/.exec(v);
    if (!m) return v ? [UNKNOWN_HOST] : [];
    return m[1] ? [read(m[1])] : [];
  }
  if (CURL_PROXIES.has(opt.name)) return v ? [read(v)] : [];
  return [];
}

/** One curl/wget transfer: its URLs, overrides, uploads and output files (indices into `args`). */
function transfer(args: string[], isCurl: boolean): NetResult {
  const p = parseArgs(args, isCurl ? CURL_VALUES : WGET_VALUES);
  const targets = [...p.positionals, ...p.opts.filter((o) => o.name === '--url').map((o) => o.value ?? '')];
  const overrides = isCurl ? p.opts.flatMap(curlOverrideHosts) : [];
  const upload = p.opts.some((o) => (isCurl ? CURL_UPLOADS : WGET_UPLOADS).has(o.name));
  return {
    contacted: [...compact(targets.map((t) => hostFromTarget(t))), ...overrides.filter((h) => h !== UNKNOWN_HOST)],
    destinations: upload
      ? [...(targets.length ? targets.map((t) => hostFromTarget(t) ?? UNKNOWN_HOST) : [UNKNOWN_HOST]), ...overrides]
      : null,
    outputs: outputsOf(p, isCurl ? CURL_OUTPUTS : WGET_OUTPUTS),
  };
}

/** curl runs each `--next` (`-:`) section as a transfer of its own. */
function curlTransfers(args: string[]): NetResult {
  const out: NetResult = { contacted: [], destinations: null, outputs: [] };
  let start = 0;
  for (let i = 0; i <= args.length; i++) {
    if (i < args.length && args[i] !== '--next' && args[i] !== '-:') continue;
    const t = transfer(args.slice(start, i), true);
    out.contacted.push(...t.contacted);
    if (t.destinations) out.destinations = [...(out.destinations ?? []), ...t.destinations];
    out.outputs.push(...t.outputs.map((at) => start + at));
    start = i + 1;
  }
  return out;
}

const outputsOf = (p: Parsed, outputs: ReadonlySet<string>) =>
  p.opts.filter((o) => outputs.has(o.name) && o.at >= 0).map((o) => o.at);

function hostTool(target: string | undefined, s: Simple): NetResult {
  const host = target ? hostFromTarget(target, true) : null;
  return { contacted: compact([host]), destinations: fedInput(s) ? [host ?? UNKNOWN_HOST] : null, outputs: [] };
}

function netTool(name: string, args: string[], s: Simple): NetResult | null {
  switch (name) {
    case 'curl':
      return curlTransfers(args);
    case 'wget':
      return transfer(args, false);
    case 'nc':
    case 'ncat':
    case 'netcat':
    case 'telnet': {
      const p = parseArgs(args, NC_VALUES);
      if (p.opts.some((o) => o.name === '-l' || o.name === '--listen')) return { contacted: [], destinations: null, outputs: [] };
      return hostTool(p.positionals[0], s);
    }
    case 'ssh':
      return hostTool(parseArgs(args, SSH_VALUES).positionals[0], s);
    case 'socat': {
      const hosts = compact(
        args.map((a) => {
          const m = /^(?:tcp|tcp4|tcp6|udp|udp4|udp6|openssl|ssl)(?:-connect)?:(\[[^\]]+\]|[^:,]+)/i.exec(a);
          return m ? hostFromTarget(m[1], true) : null;
        }),
      );
      return { contacted: hosts, destinations: fedInput(s) ? (hosts.length ? hosts : [UNKNOWN_HOST]) : null, outputs: [] };
    }
    case 'scp':
    case 'rsync': {
      const operands = parseArgs(args, name === 'scp' ? SCP_VALUES : RSYNC_VALUES).positionals.map(operandHost);
      const destination = operands.length > 1 ? operands[operands.length - 1] : null;
      return {
        contacted: compact(operands).filter((h) => h !== UNKNOWN_HOST),
        destinations: destination === null ? null : [destination],
        outputs: [],
      };
    }
    case 'sftp': {
      const p = parseArgs(args, SFTP_VALUES);
      const target = p.positionals[0] ?? '';
      const host = remoteHost(target) ?? hostFromTarget(target, true);
      const upload = fedInput(s) || p.opts.some((o) => o.name === '-b');
      return { contacted: compact([host]), destinations: upload ? [host ?? UNKNOWN_HOST] : null, outputs: [] };
    }
    case 'ftp':
    case 'tftp':
    case 'lftp':
      return hostTool(args.find((a) => !a.startsWith('-')), s);
    case 'aria2c':
      return { contacted: compact(args.filter((a) => !a.startsWith('-')).map((a) => hostFromTarget(a))), destinations: null, outputs: [] };
    case 'http':
    case 'https':
    case 'xh':
    case 'xhs': {
      const positionals = args.filter((a) => !a.startsWith('-'));
      const items = /^[A-Z]+$/.test(positionals[0] ?? '') ? positionals.slice(1) : positionals;
      const [target, ...rest] = items;
      const host = target ? hostFromTarget(target, true) : null;
      const upload = fedInput(s) || rest.some((a) => /^[^=:@\s]+(?:=(?!=)|:=|@)/.test(a));
      return { contacted: compact([host]), destinations: upload ? [host ?? UNKNOWN_HOST] : null, outputs: [] };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// cloud CLIs
// ---------------------------------------------------------------------------

const AWS_VALUES = set(`--profile --region --output --endpoint-url --query --color --cli-read-timeout
  --cli-connect-timeout --ca-bundle --cli-binary-format`);
const AWS_MUTATING = /^(?:create|delete|put|update|modify|terminate|run|start|stop|reboot|attach|detach|remove|set|add|associate|disassociate|import|deregister|register|revoke|authorize|enable|disable|tag|untag|invoke|publish|send|restore|reset|replace|cancel|release|allocate|deploy|apply|execute|copy|upgrade|accept|reject|rotate|purge|change|batch-write|batch-delete|write|upload|complete)(?:-|$)/;
const AWS_S3_MUTATING = set('cp mv rm sync mb rb website');
const KUBECTL_VALUES = set(`-n --namespace --context --cluster --user -s --server --kubeconfig --token
  --as --as-group --certificate-authority --client-certificate --client-key -v --v --request-timeout
  -l --selector -o --output -f --filename --field-selector --cache-dir --tls-server-name --password
  --username --log-file -c --container --profile --profile-output -k --kustomize --template`);
const KUBECTL_MUTATING = set(`apply create delete edit patch replace scale set label annotate drain cordon
  uncordon taint expose run exec cp autoscale attach debug certificate`);
const KUBECTL_ROLLOUT_MUTATING = set('restart undo pause resume');
const GCLOUD_AZ_VALUES = set(`--project --zone --region --format --filter --account --configuration
  --impersonate-service-account --verbosity --billing-project --flags-file --name -n --resource-group -g
  --subscription --output -o --query --location -l --ids --limit --page-size --sort-by`);
const GCLOUD_AZ_MUTATING = set(`create delete update set add remove deploy apply patch reset start stop
  restart resize import enable disable attach detach move rename cancel rollback upgrade purge invoke
  execute replace scale swap terminate destroy`);
const GCLOUD_AZ_READ = set(`list describe show get ls cat read info help version wait tail logs search
  query export get-iam-policy get-credentials`);
const RELEASE_TRACKS = set('alpha beta preview');
const PULUMI_VALUES = set(`-C --cwd -s --stack --color -v --verbose --tracing --profiling --memprofilerate
  --config-file`);
const TERRAFORM_MUTATING = set('apply destroy import taint untaint force-unlock');
const TERRAFORM_STATE_MUTATING = set('rm mv push replace-provider');
const PULUMI_MUTATING = set('up update destroy import refresh cancel');

function cloudMutation(name: string, args: string[]): string | null {
  switch (name) {
    case 'aws': {
      const [service, op] = parseArgs(args, AWS_VALUES).positionals;
      if (!service || !op) return null;
      const mutating = service === 's3' ? AWS_S3_MUTATING.has(op) : AWS_MUTATING.test(op);
      return mutating ? `aws ${service} ${op}` : null;
    }
    case 'gcloud':
    case 'az': {
      // The command path is [release track] group [subgroups...] verb [resource...]. The first word
      // is always a group (`gcloud deploy releases list`), and the first verb after it decides
      // (`instances describe delete` describes a resource named delete).
      const path = parseArgs(args, GCLOUD_AZ_VALUES).positionals;
      const groupAt = name === 'gcloud' && RELEASE_TRACKS.has(path[0]) ? 1 : 0;
      const verb = path.slice(groupAt + 1).find((a) => GCLOUD_AZ_MUTATING.has(a) || GCLOUD_AZ_READ.has(a));
      return verb && GCLOUD_AZ_MUTATING.has(verb) ? `${name} ... ${verb}` : null;
    }
    case 'kubectl':
    case 'oc': {
      const [verb, sub] = parseArgs(args, KUBECTL_VALUES).positionals;
      if (!verb) return null;
      if (verb === 'rollout') return sub && KUBECTL_ROLLOUT_MUTATING.has(sub) ? `${name} rollout ${sub}` : null;
      return KUBECTL_MUTATING.has(verb) ? `${name} ${verb}` : null;
    }
    case 'terraform':
    case 'tofu': {
      const [verb, sub] = args.filter((a) => !a.startsWith('-'));
      if (!verb) return null;
      if (verb === 'state') return sub && TERRAFORM_STATE_MUTATING.has(sub) ? `${name} state ${sub}` : null;
      if (verb === 'workspace') return sub === 'delete' ? `${name} workspace delete` : null;
      return TERRAFORM_MUTATING.has(verb) ? `${name} ${verb}` : null;
    }
    case 'pulumi': {
      const [verb, sub] = parseArgs(args, PULUMI_VALUES).positionals;
      if (!verb) return null;
      if (verb === 'stack') return sub === 'rm' ? 'pulumi stack rm' : null;
      if (verb === 'state') return sub === 'delete' || sub === 'unprotect' ? `pulumi state ${sub}` : null;
      return PULUMI_MUTATING.has(verb) ? `pulumi ${verb}` : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// interpreter one-liners (bounded: literal destinations only)
// ---------------------------------------------------------------------------

const INTERPRETER = /^(?:python[\d.]*|node|nodejs|perl|ruby|deno|bun)$/;
const SCRIPT_FLAGS = set('-c -e -E --eval -p --print');
/**
 * A networking call in the text just before a literal: the literal is only a
 * destination when something connects to it (`print("169.254.169.254")` is not).
 */
const NETWORK_CALL =
  /\b(?:socket|connect|create_connection|urlopen|urllib|requests|httpx|aiohttp|HTTPS?Connection|http\.client|fetch|axios|net|tls|dgram|https?|Socket|TCPSocket|UDPSocket|IO::Socket|LWP|HTTP::Tiny|Net::HTTP|open-uri|Faraday)\b/;
/** How far before a literal the networking call may be. */
const NETWORK_CALL_WINDOW = 120;

/** Literal destination forms, each capturing the host. */
const DESTINATION_FORMS: readonly RegExp[] = [
  // a quoted IP address: "169.254.169.254", "fd00:ec2::254"
  /["'](\d+\.\d+\.\d+\.\d+|\[?[0-9a-fA-F]*:[0-9a-fA-F:.]*:[0-9a-fA-F:.]*\]?)["']/g,
  // a quoted host:port: "host:80"
  /["']((?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\]):\d{1,5})["']/g,
  // host first: ("host", 80)
  /["']([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])["']\s*,\s*\d{1,5}\b/g,
  // port first: connect(80, "host")
  /\(\s*\d{1,5}\s*,\s*["']([^"'\s]+)["']/g,
  // object or keyword form: {host: "x"}, {"hostname": "x"}, host="x"
  /["']?\b(?:host|hostname)["']?\s*[:=]\s*["']([^"'\s]+)["']/g,
];

/** Hosts a one-liner names literally right after a networking call. Bounded on purpose: no interpreter analysis. */
function scriptHosts(script: string): string[] {
  const out: string[] = [];
  for (const form of DESTINATION_FORMS) {
    for (const m of script.matchAll(form)) {
      const before = script.slice(Math.max(0, (m.index ?? 0) - NETWORK_CALL_WINDOW), m.index);
      if (!NETWORK_CALL.test(before)) continue;
      const h = hostFromTarget(m[1], true);
      if (h && !out.includes(h)) out.push(h);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// raw scans
// ---------------------------------------------------------------------------

const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/[^\s'"`<>|;&()\\]+/gi;
const NETWORK_SCHEMES = set('http https ftp ftps ws wss sftp scp ssh rsync telnet gopher');
const DEV_NET = /\/dev\/(?:tcp|udp)\/([^/\s'"]+)\//g;

const CREDENTIAL_PATHS: readonly RegExp[] = [
  /\.aws\/(?:credentials|sso\/cache)(?![\w.-])/,
  /\.ssh\/id_[A-Za-z0-9_-]+(?![\w.-])/,
  /\.netrc(?![\w.-])/,
  /\.git-credentials(?![\w.-])/,
  /\.npmrc(?![\w.-])/,
  /\.pypirc(?![\w.-])/,
  /\.docker\/config\.json(?![\w.-])/,
  /\.kube\/config(?![\w.-])/,
  /\.config\/gcloud\//,
  /\.azure\//,
  /(?:^|[\s/'"=@<:(])\.env(?:\.[\w-]+)?(?![\w./-])/,
  /\/etc\/shadow(?![\w.-])/,
  /[\w-]\.(?:pem|key|p12|pfx)(?![\w.-])/,
];

/** The credential files a string names, as written and with `.`/`..` segments resolved. */
export function credentialPathsIn(text: string): string[] {
  const out: string[] = [];
  const spellings = text.includes('/') ? [text, posix.normalize(text)] : [text];
  for (const spelling of spellings) {
    for (const re of CREDENTIAL_PATHS) {
      const m = re.exec(spelling);
      if (m) {
        const found = m[0].replace(/^[\s'"=@<:(]/, '');
        if (!out.includes(found)) out.push(found);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

const SHELLS = set('sh bash zsh dash ksh ash mksh');
const NAMESPACE_ESCAPE = set('unshare nsenter');
const MAX_DEPTH = 4;
const WRITE_REDIRECT = /^(?:>|>>|>\||&>|&>>|>&)$/;

function empty(): CommandAnalysis {
  return {
    commands: [],
    hosts: [],
    uploads: [],
    network: false,
    credentialPaths: [],
    namespaceEscape: null,
    cloudMutation: null,
  };
}

/** Appends what `xs` does not already hold, keeping first-seen order. */
function addAll(xs: string[], ys: readonly string[]): void {
  for (const y of ys) if (!xs.includes(y)) xs.push(y);
}

function merge(into: CommandAnalysis, from: CommandAnalysis): void {
  addAll(into.commands, from.commands);
  addAll(into.hosts, from.hosts);
  addAll(into.credentialPaths, from.credentialPaths);
  into.uploads.push(...from.uploads);
  into.network ||= from.network;
  into.namespaceEscape ??= from.namespaceEscape;
  into.cloudMutation ??= from.cloudMutation;
}

/** Hosts in `host:port` and `user@host:` words, whatever command carries them. */
function hostInWord(word: string): string | null {
  if (/^[^@\s/:]+@(?:\[[^\]]+\]|[^:\s/@]+):/.test(word)) return remoteHost(word);
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]*[A-Za-z.][A-Za-z0-9.-]*):\d{1,5}(?:\/.*)?$/.exec(word);
  return m ? hostFromTarget(word) : null;
}

function analyse(src: string, depth: number): CommandAnalysis {
  const result = empty();
  const subs: string[] = [];
  const nested: string[] = [];
  const simples = simpleCommands(tokenize(src, subs));

  for (const s of simples) {
    addAll(result.hosts, compact(s.words.map(hostInWord)));
    // words that are read: everything except output files and text handed to a nested reading
    const notRead = new Set<number>();
    for (const r of s.redirs) {
      if (!WRITE_REDIRECT.test(r.op)) addAll(result.credentialPaths, credentialPathsIn(r.target));
    }
    const cmd = commandOf(s.words);
    if (cmd && 'split' in cmd) nested.push(cmd.split);
    else if (cmd) {
      const { name, args, offset } = cmd;
      addAll(result.commands, [name]);
      if (NAMESPACE_ESCAPE.has(name)) result.namespaceEscape ??= name;
      result.cloudMutation ??= cloudMutation(name, args);
      const net = netTool(name, args, s);
      if (net) {
        addAll(result.hosts, net.contacted);
        result.network = true;
        if (net.destinations) result.uploads.push({ tool: name, hosts: net.destinations });
        for (const at of net.outputs) notRead.add(offset + at);
      }
      if (name === 'tee') args.forEach((_, k) => notRead.add(offset + k));
      if (SHELLS.has(name)) {
        const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
        if (c >= 0 && args[c + 1] !== undefined) {
          nested.push(args[c + 1]);
          notRead.add(offset + c + 1);
        }
      } else if (name === 'eval') {
        nested.push(args.join(' '));
        args.forEach((_, k) => notRead.add(offset + k));
      } else if (INTERPRETER.test(name)) {
        const f = args.findIndex((a) => SCRIPT_FLAGS.has(a));
        const hosts = f >= 0 && args[f + 1] !== undefined ? scriptHosts(args[f + 1]) : [];
        if (hosts.length) {
          addAll(result.hosts, hosts);
          result.network = true;
        }
      }
    }
    s.words.forEach((w, k) => notRead.has(k) || addAll(result.credentialPaths, credentialPathsIn(w)));
  }
  if (depth < MAX_DEPTH) for (const text of [...nested, ...subs]) merge(result, analyse(text, depth + 1));

  for (const m of src.matchAll(URL_IN_TEXT)) {
    const host = hostFromUrl(m[0]);
    if (host) addAll(result.hosts, [host]);
    if (NETWORK_SCHEMES.has(m[1].toLowerCase())) result.network = true;
  }
  for (const m of src.matchAll(DEV_NET)) {
    const host = hostFromTarget(m[1], true);
    if (host) addAll(result.hosts, [host]);
    result.network = true;
  }
  return result;
}

export function analyseCommand(command: string): CommandAnalysis {
  return analyse(command, 0);
}
