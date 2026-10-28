/**
 * The pure Airlock evaluator: (policy, one tool call) -> verdict.
 *
 *  1. mode off -> allow
 *  2. the session's model is not selected -> allow
 *  3. every finding across every capability; any deny outranks any
 *     needs-human-approval. Deny order: built-in metadata hosts, IOC hosts, the
 *     deny list, namespace escape, credential read + network, upload to an
 *     unlisted host; then publishing through an allowed host, then cloud mutation.
 *  4. an approval whose key is in card.grants is allowed ('approved')
 *  5. observe mode returns allow carrying the verdict enforce would give
 *
 * The tool's name is never read.
 */
import { createHash } from 'node:crypto';
import { matchHost, hostFromUrl } from './hosts';
import { analyseCommand, credentialPathsIn, UNKNOWN_HOST } from './shell';
import {
  BUILTIN_DENY_HOSTS,
  type AirlockApproval,
  type AirlockDenial,
  type AirlockInput,
  type AirlockPolicy,
  type AirlockRuleId,
  type AirlockRules,
  type AirlockVerdict,
  type Capability,
  type ModelSelector,
  type RuleAction,
} from './types';

/** Priority order: earlier outranks later within the same decision. */
const RULE_ORDER: readonly AirlockRuleId[] = [
  'builtin-metadata-deny',
  'ioc-host',
  'denied-host',
  'namespace-escape',
  'credential-read-with-network',
  'upload-to-unlisted-host',
  'publish-through-allowed-host',
  'cloud-mutation',
];

const RULE_SETTING: Partial<Record<AirlockRuleId, keyof AirlockRules>> = {
  'upload-to-unlisted-host': 'uploadToUnlistedHost',
  'credential-read-with-network': 'credentialReadWithNetwork',
  'namespace-escape': 'namespaceEscape',
  'publish-through-allowed-host': 'publishThroughAllowedHost',
  'cloud-mutation': 'cloudMutation',
};

interface Finding {
  rule: AirlockRuleId;
  reason: string;
  target?: string;
  /** every capability the finding rests on; the approval key binds all of them */
  caps: Capability[];
}

function canonicalCapability(cap: Capability): string {
  switch (cap.kind) {
    case 'command':
      return JSON.stringify(['command', cap.command.trim()]);
    case 'path':
      return JSON.stringify(['path', cap.access, cap.path]);
    case 'url':
      return JSON.stringify(['url', cap.url.trim()]);
  }
}

/**
 * Stable key a person grants on the board; bound to the rule, the project and
 * EVERY capability the finding rests on (for credential-read-with-network, the
 * read and the network access both), so changing any one of them needs a new grant.
 */
export function approvalKeyOf(
  rule: AirlockRuleId,
  cap: Capability | readonly Capability[],
  projectId?: string,
): string {
  const caps = (Array.isArray(cap) ? cap : [cap]) as readonly Capability[];
  const canonical = [...new Set(caps.map(canonicalCapability))].sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([rule, canonical, projectId ?? null]))
    .digest('hex');
  return `airlock-v1:${rule}:${digest.slice(0, 40)}`;
}

function glob(pattern: string | undefined, value: string | null): boolean {
  if (pattern === undefined || pattern === '*') return true;
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i',
  );
  return re.test(value ?? '');
}

function selectorMatches(s: ModelSelector, input: AirlockInput): boolean {
  return (
    (s.client === undefined || s.client === '*' || s.client === input.client) &&
    glob(s.provider, input.model.provider) &&
    glob(s.model, input.model.id)
  );
}

function modelSelected(policy: AirlockPolicy, input: AirlockInput): boolean {
  if (!input.model?.id) return policy.appliesWhenModelUnknown;
  return policy.models.length === 0 || policy.models.some((s) => selectorMatches(s, input));
}

function hostFindings(policy: AirlockPolicy, host: string, cap: Capability): Finding[] {
  if (matchHost(host, BUILTIN_DENY_HOSTS)) {
    return [{ rule: 'builtin-metadata-deny', reason: `${host} is a cloud metadata endpoint`, target: host, caps: [cap] }];
  }
  if (matchHost(host, policy.iocHosts.hosts)) {
    return [{ rule: 'ioc-host', reason: `${host} is on the indicator-of-compromise list`, target: host, caps: [cap] }];
  }
  if (matchHost(host, policy.hosts.deny)) {
    return [{ rule: 'denied-host', reason: `${host} is on the deny list`, target: host, caps: [cap] }];
  }
  return [];
}

function findingsOf(policy: AirlockPolicy, input: AirlockInput): Finding[] {
  const findings: Finding[] = [];
  const credentials: { path: string; cap: Capability }[] = [];
  const networkCaps: Capability[] = [];

  for (const cap of input.capabilities) {
    if (cap.kind === 'url') {
      const host = hostFromUrl(cap.url);
      if (host) findings.push(...hostFindings(policy, host, cap));
      networkCaps.push(cap);
    } else if (cap.kind === 'path') {
      const [path] = cap.access === 'read' ? credentialPathsIn(cap.path) : [];
      if (path) credentials.push({ path: cap.path, cap });
    } else {
      const a = analyseCommand(cap.command);
      for (const host of a.hosts) findings.push(...hostFindings(policy, host, cap));
      if (a.namespaceEscape) {
        findings.push({
          rule: 'namespace-escape',
          reason: `${a.namespaceEscape} can leave the sandbox's namespaces`,
          target: a.namespaceEscape,
          caps: [cap],
        });
      }
      for (const upload of a.uploads) {
        const unlisted = upload.hosts.filter((h) => h === UNKNOWN_HOST || !matchHost(h, policy.hosts.allow));
        for (const host of unlisted) {
          findings.push({
            rule: 'upload-to-unlisted-host',
            reason: `${upload.tool} sends data to ${host}, which is not on the allow list`,
            target: host,
            caps: [cap],
          });
        }
      }
      if (a.publish) {
        findings.push({ rule: 'publish-through-allowed-host', reason: `${a.publish} sends data to a service, whatever host it is on`, target: a.publish, caps: [cap] });
      }
      if (a.cloudMutation) {
        findings.push({ rule: 'cloud-mutation', reason: `${a.cloudMutation} changes cloud resources`, target: a.cloudMutation, caps: [cap] });
      }
      if (a.credentialPaths.length) credentials.push({ path: a.credentialPaths[0], cap });
      if (a.network) networkCaps.push(cap);
    }
  }
  if (credentials.length && networkCaps.length) {
    findings.push({
      rule: 'credential-read-with-network',
      reason: `reads credentials (${credentials.map((c) => c.path).join(', ')}) in a call that can reach the network`,
      target: credentials[0].path,
      // every read and every network access: a grant covers exactly this combination
      caps: [...credentials.map((c) => c.cap), ...networkCaps],
    });
  }
  return findings;
}

function actionOf(policy: AirlockPolicy, rule: AirlockRuleId): RuleAction {
  const setting = RULE_SETTING[rule];
  return setting ? policy.rules[setting] : 'deny';
}

function rawVerdict(policy: AirlockPolicy, input: AirlockInput): AirlockVerdict {
  const ranked = findingsOf(policy, input)
    .map((f) => ({ f, action: actionOf(policy, f.rule) }))
    .filter((x) => x.action !== 'off')
    .sort((a, b) => RULE_ORDER.indexOf(a.f.rule) - RULE_ORDER.indexOf(b.f.rule));

  const deny = ranked.find((x) => x.action === 'deny');
  if (deny) {
    const { rule, reason, target } = deny.f;
    const denial: AirlockDenial = { decision: 'deny', rule, reason };
    if (target !== undefined) denial.target = target;
    return denial;
  }

  const grants = new Set(input.card?.grants ?? []);
  const projectId = input.card?.projectId;
  let approved = false;
  for (const { f } of ranked) {
    const approvalKey = approvalKeyOf(f.rule, f.caps, projectId);
    if (grants.has(approvalKey)) {
      approved = true;
      continue;
    }
    const approval: AirlockApproval = { decision: 'needs-human-approval', rule: f.rule, reason: f.reason, approvalKey, capabilities: [...f.caps] };
    if (f.target !== undefined) approval.target = f.target;
    return approval;
  }
  return { decision: 'allow', why: approved ? 'approved' : 'no-rule-matched' };
}

export function evaluateAirlock(policy: AirlockPolicy, input: AirlockInput): AirlockVerdict {
  if (policy.mode === 'off') return { decision: 'allow', why: 'mode-off' };
  if (!modelSelected(policy, input)) return { decision: 'allow', why: 'model-not-selected' };
  const verdict = rawVerdict(policy, input);
  if (policy.mode === 'observe' && verdict.decision !== 'allow') {
    return { decision: 'allow', why: 'observe-mode', observed: verdict };
  }
  return verdict;
}
