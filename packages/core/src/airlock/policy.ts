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
  type AirlockRules,
  type HostPattern,
  type ModelSelector,
  type RuleAction,
} from './types';
import { isValidHostPattern, matchHost, normalizeHost, parseCidr } from './hosts';

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

export function normalizeAirlockPolicy(raw: unknown): AirlockPolicy {
  const r = isObject(raw) ? raw : {};
  const hosts = isObject(r.hosts) ? r.hosts : {};
  const ioc = isObject(r.iocHosts) ? r.iocHosts : {};
  const rules = isObject(r.rules) ? r.rules : {};
  const normalizedRules = { ...DEFAULT_AIRLOCK_RULES } as AirlockRules;
  for (const k of RULE_KEYS) {
    if (ACTIONS.includes(rules[k] as RuleAction)) normalizedRules[k] = rules[k] as RuleAction;
  }
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
  };
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
  if (raw.rules !== undefined) {
    if (!isObject(raw.rules)) errors.push('rules must be an object');
    else
      for (const k of RULE_KEYS) {
        const v = raw.rules[k];
        if (v !== undefined && !ACTIONS.includes(v as RuleAction)) {
          errors.push(`rules.${k} must be one of ${ACTIONS.join(', ')}`);
        }
      }
  }
  return errors;
}
