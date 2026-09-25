/**
 * 5a8d22e6 — the test report a project's own runner can write, as a ready command.
 *
 * A step whose checks need per-test results is refused on a project with no
 * test report. That refusal used to repeat a placeholder hint once per check,
 * and the agent read it as a person's decision. It now names the fix, built
 * from the verify command the project already runs - for the runners whose
 * report flags are certain. Anything else gets no guess: a made-up command
 * that writes nothing would only move the refusal one verify later.
 */
export interface SuggestedReport {
  format: 'vitest-json' | 'junit-xml';
  command: string;
  reportPath: string;
}

const VITEST_JSON = '.agenfk/test-report.json';
const JUNIT_XML = '.agenfk/test-report.xml';
const VITEST_FLAGS = `--reporter=default --reporter=json --outputFile.json=${VITEST_JSON}`;

/** What `runner` needs appended, or null when it is not one we know. */
function flagsFor(runner: string): Omit<SuggestedReport, 'command'> & { flags: string } | null {
  if (/\bvitest\b/.test(runner)) return { format: 'vitest-json', reportPath: VITEST_JSON, flags: VITEST_FLAGS };
  if (/\bpytest\b/.test(runner)) return { format: 'junit-xml', reportPath: JUNIT_XML, flags: `--junitxml=${JUNIT_XML}` };
  // node reads no options after its first file argument: only a bare `node --test` takes them at the end.
  if (/\bnode\s+--test\s*$/.test(runner)) {
    return { format: 'junit-xml', reportPath: JUNIT_XML, flags: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${JUNIT_XML}` };
  }
  return null;
}

/**
 * The report `verifyCommand` can write, given the project's package.json
 * scripts (an `npm test` runs whatever its script says). Null: no certain answer.
 */
export function suggestTestReport(verifyCommand: string, scripts: Record<string, string>): SuggestedReport | null {
  // Pipes, `;`, `||` or a subshell: where appended flags land is not certain.
  if (/[|;`]|\$\(/.test(verifyCommand.replace(/&&/g, ''))) return null;
  // `npm run build && npm test`: the report comes from the part that runs the tests - the last one that does.
  const parts = verifyCommand.split('&&').map(p => p.trim());
  // A `cd` moves where the report is written away from where it is read.
  if (parts.some(p => /^cd\s/.test(p))) return null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = suggestOne(parts[i], scripts);
    if (!s) continue;
    return { ...s, command: [...parts.slice(0, i), s.command, ...parts.slice(i + 1)].join(' && ') };
  }
  return null;
}

function suggestOne(cmd: string, scripts: Record<string, string>): SuggestedReport | null {
  // Flags after a `--` already there are not the runner's (vitest keeps them aside).
  if (/(^|\s)--(\s|$)/.test(cmd)) return null;
  // A workspace or prefix runs the script elsewhere, with its own package.json.
  if (/(^|\s)(-w|--workspace|--prefix|-C)(\s|=|$)/.test(cmd)) return null;
  // npm passes flags after `--` to the END of the script: only a script that is the runner alone is certain.
  const pm = /^npm\s+(?:run\s+)?([\w:.-]+)$/.exec(cmd) ?? /^npm\s+test(?:\s|$)/.exec(cmd);
  if (/^(npm|pnpm|yarn|bun)\b/.test(cmd)) {
    if (!pm) return null;
    const name = pm[1] ?? 'test';
    const script = scripts[name];
    if (typeof script !== 'string' || /&&|\|\||[|;`]|\$\(/.test(script)) return null;
    const f = flagsFor(script);
    return f ? { format: f.format, reportPath: f.reportPath, command: `${cmd} -- ${f.flags}` } : null;
  }
  // `node --test <files>`: the flags go straight after `--test`, before the files.
  const nodeTest = /^(.*\bnode\s+--test)(\s.*)?$/.exec(cmd);
  if (nodeTest) {
    const f = flagsFor('node --test');
    return f ? { format: f.format, reportPath: f.reportPath, command: `${nodeTest[1]} ${f.flags}${nodeTest[2] ?? ''}` } : null;
  }
  const f = flagsFor(cmd);
  return f ? { format: f.format, reportPath: f.reportPath, command: `${cmd} ${f.flags}` } : null;
}
