/**
 * C3b (efcacdeb) — `agenfk verify --check <name>=pass|fail` and
 * `--check-note <name>=<text>`, both repeatable: the coding agent's report of
 * the step's agent checks, sent to the server as `agentChecks`.
 *
 * Refused HERE, before anything is sent: a typo in a flag would otherwise come
 * back from the server as "not reported yet", after a verify that may have run
 * a whole suite. The name rule is the server's (parseAgentReports).
 */

export interface AgentCheckReport { name: string; outcome: 'pass' | 'fail'; note?: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Split `name=value` at the FIRST `=`: a note may contain more. */
function split(flag: string): { name: string; value: string } | null {
  const at = flag.indexOf('=');
  return at < 0 ? null : { name: flag.slice(0, at).trim(), value: flag.slice(at + 1) };
}

export function parseCheckFlags(checks: readonly string[], notes: readonly string[]): { agentChecks: AgentCheckReport[] } | { error: string } {
  const out: AgentCheckReport[] = [];
  for (const flag of checks) {
    const kv = split(flag);
    if (!kv) return { error: `--check ${flag}: give it as --check ${flag}=pass (or =fail).` };
    if (!NAME.test(kv.name)) return { error: `--check ${flag}: ${JSON.stringify(kv.name)} is not an agent check's name (lowercase letters, digits and dashes).` };
    const outcome = kv.value.trim();
    if (outcome !== 'pass' && outcome !== 'fail') return { error: `--check ${flag}: report '${kv.name}' as pass or fail.` };
    if (out.some(r => r.name === kv.name)) return { error: `--check: '${kv.name}' is reported twice.` };
    out.push({ name: kv.name, outcome });
  }
  for (const flag of notes) {
    const kv = split(flag);
    if (!kv || !kv.name) return { error: `--check-note ${flag}: give it as --check-note <name>=<what you found>.` };
    const report = out.find(r => r.name === kv.name);
    if (!report) return { error: `--check-note ${kv.name}: there is no --check ${kv.name}=pass|fail for it to go with.` };
    const note = kv.value.trim();
    if (!note) continue;
    const joined = report.note ? `${report.note}\n${note}` : note;
    // The server's limit is on the JOINED note, so that is what is checked here.
    if (joined.length > 2000) return { error: `--check-note ${kv.name}: the notes for '${kv.name}' come to more than 2000 characters.` };
    report.note = joined;
  }
  return { agentChecks: out };
}
