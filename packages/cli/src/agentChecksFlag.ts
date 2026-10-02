/**
 * C3b (efcacdeb) — `agenfk verify --check <name>=pass|fail` and
 * `--check-note <name>=<text>`, both repeatable: the coding agent's report of
 * the step's agent checks, sent to the server as `agentChecks`.
 *
 * A `--check-note` with no `--check` of its name answers one of the step's
 * built-in checks instead - a failing warning on the step that writes tests
 * holds the card until it is answered (CGLAB-420). Sent as `checkAnswers`.
 *
 * Refused HERE, before anything is sent: a typo in a flag would otherwise come
 * back from the server as "not reported yet", after a verify that may have run
 * a whole suite. The name rule is the server's (parseAgentReports).
 */

export interface AgentCheckReport { name: string; outcome: 'pass' | 'fail'; note?: string }
export interface CheckAnswer { id: string; note: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Split `name=value` at the FIRST `=`: a note may contain more. */
function split(flag: string): { name: string; value: string } | null {
  const at = flag.indexOf('=');
  return at < 0 ? null : { name: flag.slice(0, at).trim(), value: flag.slice(at + 1) };
}

export function parseCheckFlags(checks: readonly string[], notes: readonly string[]): { agentChecks: AgentCheckReport[]; checkAnswers?: CheckAnswer[] } | { error: string } {
  const out: AgentCheckReport[] = [];
  const answers: CheckAnswer[] = [];
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
    const note = kv.value.trim();
    if (!report) {
      // CGLAB-420: the answer to one of the step's checks.
      if (!/^[a-z0-9][a-z0-9:-]{0,80}$/.test(kv.name)) return { error: `--check-note ${flag}: ${JSON.stringify(kv.name)} is not a check's name (lowercase letters, digits, dashes and colons).` };
      if (!note) return { error: `--check-note ${kv.name}: an answer needs some text - say why the warning is fine, or what you changed.` };
      const given = answers.find(a => a.id === kv.name);
      if (given) given.note = `${given.note}\n${note}`; else answers.push({ id: kv.name, note });
      if ((given?.note ?? note).length > 2000) return { error: `--check-note ${kv.name}: the answer comes to more than 2000 characters.` };
      continue;
    }
    if (!note) continue;
    const joined = report.note ? `${report.note}\n${note}` : note;
    // The server's limit is on the JOINED note, so that is what is checked here.
    if (joined.length > 2000) return { error: `--check-note ${kv.name}: the notes for '${kv.name}' come to more than 2000 characters.` };
    report.note = joined;
  }
  return { agentChecks: out, ...(answers.length ? { checkAnswers: answers } : {}) };
}
