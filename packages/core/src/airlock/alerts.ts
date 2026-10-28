/**
 * Which logged decisions are alerts (GH-294 TEL-2): a pure function of one
 * decision record and the policy, so the server (which stores the category on
 * the record and tells the board) and the hub (which reads the record's
 * `alert` field) agree on it.
 *
 *  - metadata-endpoint: a cloud metadata address (BUILTIN_DENY_HOSTS), on any decision;
 *  - ioc-host: a host on the policy's indicator-of-compromise list, on any decision;
 *  - cloud-storage: an object-storage upload host, only when the decision is a
 *    deny (in observe mode the record holds the deny enforce would have made).
 *
 * One category per decision, in that order. A host is judged by its labels
 * against each provider's own domain, so a bucket-like name on another
 * domain (`s3.amazonaws.com.evil.example`) is not a cloud-storage host.
 */
import { hostFromTarget, hostFromUrl, matchHost, normalizeHost, parseIp } from './hosts';
import { analyseCommand, UNKNOWN_HOST } from './shell';
import { AIRLOCK_ALERTS, BUILTIN_DENY_HOSTS, type AirlockAlert, type AirlockPolicy } from './types';

export { AIRLOCK_ALERTS, type AirlockAlert };

/** What the classifier reads of a decision record. */
export interface AirlockAlertInput {
  /** 'command' | 'path' | 'url' (a tool call) or 'host' (the sandbox proxy: `host:port`) */
  capabilityKind: string | null;
  /** the redacted target as logged */
  target: string | null;
  decision: 'allow' | 'deny' | 'needs-human-approval';
  rule?: string | null;
}

/** `us-east-1`, `cn-north-1`, `us-gov-west-1`, `us-iso-east-1`. */
const AWS_REGION = /^[a-z]{2}(?:-gov|-iso[a-z]*)?-[a-z]+-\d+$/;
/** s3, s3-accelerate, s3-us-west-2, s3-fips, s3-accesspoint, s3-website, s3express-usw2-az1 ... */
const S3_LABEL = /^s3(?:express)?(?:-[a-z0-9-]+)?$/;

/**
 * `[bucket.]<s3 label>[.dualstack|.fips][.<region>]`: the S3 label is followed
 * only by dual-stack, FIPS or region labels, so `s3-x.us-east-1.elb.amazonaws.com`
 * (a load balancer someone named s3-x) is not S3.
 */
function s3Endpoint(left: string[]): boolean {
  return left.some((l, i) => S3_LABEL.test(l) && left.slice(i + 1).every((r) => r === 'dualstack' || r === 'fips' || AWS_REGION.test(r)));
}

/** `<account>.<blob|dfs|file>.core...`: the service is the label right before the domain, the account the only one before it. */
const azureStorage = (left: string[]): boolean => left.length === 2 && ['blob', 'dfs', 'file'].includes(left[1]);
/** Any name under a domain only the storage provider hands out. */
const anyUnder = (left: string[]): boolean => left.length > 0;

/**
 * Object-storage endpoints: each provider's domain and the shape of the labels
 * left of it, read by position (the service label where the provider puts it,
 * never "somewhere"), so a customer-chosen name that happens to read `blob` or
 * `s3` is not a storage endpoint. `bare`: the domain itself is an endpoint
 * (path-style GCS), not only its subdomains.
 */
const STORAGE_DOMAINS: readonly { domain: string; left: (labels: string[]) => boolean; bare?: boolean }[] = [
  { domain: 'amazonaws.com', left: s3Endpoint },
  { domain: 'amazonaws.com.cn', left: s3Endpoint },
  // PrivateLink: [bucket|accesspoint|control].vpce-<id>.s3.<region>.vpce.amazonaws.com
  { domain: 'vpce.amazonaws.com', left: (l) => l.length >= 3 && /^vpce-[a-z0-9-]+$/.test(l[l.length - 3]) && l[l.length - 2] === 's3' && AWS_REGION.test(l[l.length - 1]) },
  { domain: 'storage.googleapis.com', left: anyUnder, bare: true },
  { domain: 'storage.cloud.google.com', left: anyUnder, bare: true },
  { domain: 'core.windows.net', left: azureStorage },
  { domain: 'core.usgovcloudapi.net', left: azureStorage },
  { domain: 'core.chinacloudapi.cn', left: azureStorage },
  { domain: 'r2.cloudflarestorage.com', left: anyUnder },
  { domain: 'backblazeb2.com', left: anyUnder },
  { domain: 'digitaloceanspaces.com', left: anyUnder },
  { domain: 'wasabisys.com', left: anyUnder },
  { domain: 'linodeobjects.com', left: anyUnder },
  // [<namespace>.compat.]objectstorage.<region>.oraclecloud.com
  { domain: 'oraclecloud.com', left: (l) => l.length >= 2 && l[l.length - 2] === 'objectstorage' && /^[a-z]{2}-[a-z]+-\d+$/.test(l[l.length - 1]) },
  { domain: 'cloud-object-storage.appdomain.cloud', left: anyUnder },
  // [bucket.]oss-<region>.aliyuncs.com
  { domain: 'aliyuncs.com', left: (l) => l.length >= 1 && /^oss-[a-z0-9-]+$/.test(l[l.length - 1]) },
  // [bucket.]s3.<region>.scw.cloud
  { domain: 'scw.cloud', left: (l) => l.length >= 2 && l[l.length - 2] === 's3' && /^[a-z]{2}-[a-z]{3}$/.test(l[l.length - 1]) },
];

export function isCloudStorageHost(raw: string): boolean {
  const host = normalizeHost(raw);
  if (!host || parseIp(host)) return false;
  return STORAGE_DOMAINS.some(({ domain, left, bare }) => {
    if (host === domain) return !!bare;
    if (!host.endsWith(`.${domain}`)) return false;
    return left(host.slice(0, -(domain.length + 1)).split('.'));
  });
}

/**
 * The hosts a proxy target (`host`, `host:port`, `[v6]:port`) can mean. The
 * proxy writes an IPv6 host unbracketed (`fd00:ec2::254:80`), where the port
 * cannot be told from the address, so both readings are judged.
 */
function proxyHosts(target: string): string[] {
  const out = new Set<string>();
  const whole = hostFromTarget(target, true);
  if (whole) out.add(whole);
  const v6WithPort = /^([0-9a-f:.]+):\d{1,5}$/i.exec(target.trim());
  if (v6WithPort?.[1].includes(':')) {
    const h = hostFromTarget(v6WithPort[1], true);
    if (h) out.add(h);
  }
  return [...out];
}

function hostsOf(d: AirlockAlertInput): string[] {
  const target = d.target;
  if (!target) return [];
  switch (d.capabilityKind) {
    case 'path':
      return [];
    case 'url': {
      const h = hostFromUrl(target);
      return h ? [h] : [];
    }
    case 'command':
      return analyseCommand(target).hosts.filter((h) => h !== UNKNOWN_HOST);
    default:
      return proxyHosts(target);
  }
}

export function airlockAlertOf(d: AirlockAlertInput, policy: Pick<AirlockPolicy, 'iocHosts'>): AirlockAlert | null {
  const hosts = hostsOf(d);
  if (d.rule === 'builtin-metadata-deny' || hosts.some((h) => matchHost(h, BUILTIN_DENY_HOSTS))) return 'metadata-endpoint';
  const ioc = policy.iocHosts?.hosts ?? [];
  if (d.rule === 'ioc-host' || hosts.some((h) => matchHost(h, ioc))) return 'ioc-host';
  if (d.decision === 'deny' && hosts.some(isCloudStorageHost)) return 'cloud-storage';
  return null;
}
