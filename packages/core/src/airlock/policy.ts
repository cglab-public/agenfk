/**
 * Two readers of a policy that arrived from outside:
 *  - normalizeAirlockPolicy repairs: a whitelist that drops what it does not
 *    know and falls back to the (off) default, like normalizeFlowSteps;
 *  - airlockPolicyErrors refuses: the list of reasons a write must not be
 *    stored. Shared by the server PUT, the hub admin PUT and the server's sync.
 */
import {
  BUILTIN_DENY_HOSTS,
  DEFAULT_AIRLOCK_RULES,
  type AirlockMode,
  type AirlockPolicy,
  type AirlockProjectOverride,
  type AirlockRules,
  type HostPattern,
  type ModelSelector,
  type RuleAction,
} from './types';
import { isValidHostPattern, matchHost, normalizeHost, parseCidr } from './hosts';
import { airlockRepoKey } from './repoKey';

const MODES: readonly AirlockMode[] = ['off', 'observe', 'enforce'];
const ACTIONS: readonly RuleAction[] = ['deny', 'needs-human-approval', 'off'];
const CLIENTS: readonly string[] = ['pi', 'opencode', '*'];
const RULE_KEYS = Object.keys(DEFAULT_AIRLOCK_RULES) as (keyof AirlockRules)[];
const SELECTOR_KEYS = ['client', 'provider', 'model'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The built-in metadata host this pattern would cover (exactly, by CIDR or by wildcard), if any. */
function coversBuiltin(pattern: string): string | null {
  return BUILTIN_DENY_HOSTS.find((builtin) => matchHost(builtin, [pattern])) ?? null;
}

function hostList(raw: unknown, dropBuiltins: boolean): HostPattern[] {
  if (!Array.isArray(raw)) return [];
  // A Set, not out.includes: a list of thousands deduplicates in linear time.
  const seen = new Set<HostPattern>();
  for (const p of raw) {
    if (typeof p !== 'string' || !isValidHostPattern(p)) continue;
    const n = normalizeHost(p);
    if (dropBuiltins && coversBuiltin(n)) continue;
    seen.add(n);
  }
  return [...seen];
}

function selector(raw: unknown): ModelSelector | null {
  if (!isObject(raw)) return null;
  const out: ModelSelector = {};
  for (const k of SELECTOR_KEYS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') return null;
    if (k === 'client' && !CLIENTS.includes(v)) return null;
    (out as Record<string, string>)[k] = v;
  }
  return out;
}

function override(raw: unknown): AirlockProjectOverride | null {
  if (!isObject(raw)) return null;
  const out: AirlockProjectOverride = {};
  if (isObject(raw.hosts)) {
    const allow = hostList(raw.hosts.allow, true);
    const deny = hostList(raw.hosts.deny, false);
    if (allow.length || deny.length) out.hosts = { allow, deny };
  }
  if (isObject(raw.rules)) {
    const rules: Partial<AirlockRules> = {};
    for (const k of RULE_KEYS) {
      if (ACTIONS.includes(raw.rules[k] as RuleAction)) rules[k] = raw.rules[k] as RuleAction;
    }
    if (Object.keys(rules).length) out.rules = rules;
  }
  return out.hosts || out.rules ? out : null;
}

/** Two raw keys naming one repository merge: their lists unite, the later rules win. */
function projectOverrides(raw: unknown): Record<string, AirlockProjectOverride> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, AirlockProjectOverride> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = airlockRepoKey(k);
    const o = key ? override(v) : null;
    if (key && o) out[key] = out[key] ? applyOverride(out[key], o) : o;
  }
  return Object.keys(out).length ? out : undefined;
}

function union(a: HostPattern[], b: HostPattern[]): HostPattern[] {
  return [...new Set([...a, ...b])];
}

function applyOverride(base: AirlockProjectOverride, o: AirlockProjectOverride): AirlockProjectOverride {
  const out: AirlockProjectOverride = {};
  if (base.hosts || o.hosts) {
    out.hosts = {
      allow: union(base.hosts?.allow ?? [], o.hosts?.allow ?? []),
      deny: union(base.hosts?.deny ?? [], o.hosts?.deny ?? []),
    };
  }
  if (base.rules || o.rules) out.rules = { ...base.rules, ...o.rules };
  return out;
}

/**
 * The policy a project runs under: the org's, with the project's repository
 * override applied, then its project:<id> one. Allow and deny lists add to the
 * org's - an override cannot remove an org deny, and evaluation ranks a deny
 * over an allow - and each rule set wins (loosen or tighten). Mode, models and
 * the IOC list stay the org's, and no allow can reach a built-in metadata host.
 * The result carries no projects.
 */
export function effectivePolicyFor(
  policy: AirlockPolicy,
  project: { repo?: string | null; projectId?: string | null },
): AirlockPolicy {
  const { projects, ...org } = policy;
  const keys = [airlockRepoKey(project.repo), project.projectId ? airlockRepoKey(`project:${project.projectId}`) : null];
  let hosts = org.hosts;
  let rules = org.rules;
  for (const key of keys) {
    const o = key ? projects?.[key] : undefined;
    if (!o) continue;
    if (o.hosts) {
      hosts = {
        allow: union(hosts.allow, o.hosts.allow.filter((h) => !coversBuiltin(normalizeHost(h)))),
        deny: union(hosts.deny, o.hosts.deny),
      };
    }
    if (o.rules) rules = { ...rules, ...o.rules };
  }
  return { ...org, hosts, rules };
}

export function normalizeAirlockPolicy(raw: unknown): AirlockPolicy {
  const r = isObject(raw) ? raw : {};
  const hosts = isObject(r.hosts) ? r.hosts : {};
  const ioc = isObject(r.iocHosts) ? r.iocHosts : {};
  const rules = isObject(r.rules) ? r.rules : {};
  const normalizedRules = { ...DEFAULT_AIRLOCK_RULES } as AirlockRules;
  for (const k of RULE_KEYS) {
    if (ACTIONS.includes(rules[k] as RuleAction)) normalizedRules[k] = rules[k] as RuleAction;
  }
  const projects = projectOverrides(r.projects);
  return {
    schemaVersion: 1,
    mode: MODES.includes(r.mode as AirlockMode) ? (r.mode as AirlockMode) : 'off',
    models: Array.isArray(r.models)
      ? r.models.map(selector).filter((s): s is ModelSelector => s !== null)
      : [],
    appliesWhenModelUnknown: typeof r.appliesWhenModelUnknown === 'boolean' ? r.appliesWhenModelUnknown : true,
    hosts: { allow: hostList(hosts.allow, true), deny: hostList(hosts.deny, false) },
    iocHosts: {
      revision: typeof ioc.revision === 'string' ? ioc.revision : '',
      hosts: hostList(ioc.hosts, false),
      updatedAt: typeof ioc.updatedAt === 'string' ? ioc.updatedAt : null,
    },
    rules: normalizedRules,
    ...(projects ? { projects } : {}),
  };
}

function rulesErrors(field: string, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) return [`${field} must be an object`];
  return RULE_KEYS.filter((k) => raw[k] !== undefined && !ACTIONS.includes(raw[k] as RuleAction)).map(
    (k) => `${field}.${k} must be one of ${ACTIONS.join(', ')}`,
  );
}

function projectsErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) return ['projects must be an object'];
  const errors: string[] = [];
  for (const [k, o] of Object.entries(raw)) {
    const field = `projects[${JSON.stringify(k)}]`;
    if (!airlockRepoKey(k)) {
      errors.push(`${field}: the key must name a repository (host/owner/repo, a git remote or owner/repo) or project:<id>`);
      continue;
    }
    if (!isObject(o)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    if (o.hosts !== undefined) {
      if (!isObject(o.hosts)) errors.push(`${field}.hosts must be an object`);
      else {
        errors.push(...hostListErrors(`${field}.hosts.allow`, o.hosts.allow, true));
        errors.push(...hostListErrors(`${field}.hosts.deny`, o.hosts.deny, false));
      }
    }
    errors.push(...rulesErrors(`${field}.rules`, o.rules));
  }
  return errors;
}

function hostListErrors(field: string, raw: unknown, isAllow: boolean): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${field} must be an array of host patterns`];
  const errors: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string') {
      errors.push(`${field} entries must be strings`);
      continue;
    }
    if (!isValidHostPattern(p)) {
      errors.push(
        p.includes('/') && !parseCidr(normalizeHost(p))
          ? `${field}: "${p}" is not a valid CIDR range`
          : `${field}: "${p}" is not a valid host pattern`,
      );
      continue;
    }
    const builtin = isAllow ? coversBuiltin(normalizeHost(p)) : null;
    if (builtin) errors.push(`${field}: "${p}" would allow the built-in metadata host ${builtin}, which is always denied`);
  }
  return errors;
}

export function airlockPolicyErrors(raw: unknown): string[] {
  if (!isObject(raw)) return ['policy must be an object'];
  const errors: string[] = [];
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (raw.mode !== undefined && !MODES.includes(raw.mode as AirlockMode)) {
    errors.push(`mode must be one of ${MODES.join(', ')}`);
  }
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) errors.push('models must be an array');
    else
      raw.models.forEach((m, i) => {
        if (!isObject(m)) return errors.push(`models[${i}] must be an object`);
        for (const k of SELECTOR_KEYS) {
          if (m[k] !== undefined && typeof m[k] !== 'string') errors.push(`models[${i}].${k} must be a string`);
        }
        if (typeof m.client === 'string' && !CLIENTS.includes(m.client)) {
          errors.push(`models[${i}].client must be one of ${CLIENTS.join(', ')}`);
        }
      });
  }
  if (raw.appliesWhenModelUnknown !== undefined && typeof raw.appliesWhenModelUnknown !== 'boolean') {
    errors.push('appliesWhenModelUnknown must be a boolean');
  }
  if (raw.hosts !== undefined) {
    if (!isObject(raw.hosts)) errors.push('hosts must be an object');
    else {
      errors.push(...hostListErrors('hosts.allow', raw.hosts.allow, true));
      errors.push(...hostListErrors('hosts.deny', raw.hosts.deny, false));
    }
  }
  if (raw.iocHosts !== undefined) {
    if (!isObject(raw.iocHosts)) errors.push('iocHosts must be an object');
    else {
      const ioc = raw.iocHosts;
      if (ioc.revision !== undefined && typeof ioc.revision !== 'string') errors.push('iocHosts.revision must be a string');
      if (ioc.updatedAt !== undefined && ioc.updatedAt !== null && typeof ioc.updatedAt !== 'string') {
        errors.push('iocHosts.updatedAt must be a string or null');
      }
      errors.push(...hostListErrors('iocHosts.hosts', ioc.hosts, false));
    }
  }
  errors.push(...rulesErrors('rules', raw.rules));
  errors.push(...projectsErrors(raw.projects));
  return errors;
}
