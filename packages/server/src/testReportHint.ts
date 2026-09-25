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

/**
 * acceaa54 — `command` made to run only `files`, or null when that is not
 * certain. Only the runners whose file arguments are known (vitest, pytest,
 * `node --test`), as the command's last `&&` part or as an npm script that is
 * the runner alone. A runner may treat a name as a filter and run a little
 * more; the caller keeps only the results for the files it asked for.
 */
export function withTestFiles(command: string, scripts: Record<string, string>, files: readonly string[]): string | null {
  if (!files.length) return null;
  // The files are single-quoted for a POSIX shell; cmd.exe would read the quotes as part of the name.
  if (process.platform === 'win32') return null;
  if (/[|;`&\n\r'"\\]|\$\(/.test(command.replace(/&&/g, ''))) return null;
  const parts = command.split('&&').map(p => p.trim());
  if (parts.some(p => /^cd\s/.test(p))) return null;
  const last = parts[parts.length - 1];
  const quoted = files.map(f => `'${f.replace(/'/g, `'\\''`)}'`).join(' ');
  if (/^(npm|pnpm|yarn|bun)\b/.test(last)) {
    if (/(^|\s)(-w|--workspace|--prefix|-C)(\s|=|$)/.test(last)) return null;
    const pm = /^npm\s+(?:run\s+)?([\w:.-]+)(\s|$)/.exec(last) ?? /^npm\s+test(\s|$)/.exec(last);
    if (!pm) return null;
    const script = scripts[pm[1] ?? 'test'];
    if (typeof script !== 'string' || /&&|\|\||[|;`&\n'"\\]|\$\(/.test(script) || !runnerWithoutTargets(script)) return null;
    // Flags the command adds after `--` must not name targets either.
    const passed = /(^|\s)--(\s|$)/.exec(last);
    if (passed && last.slice(passed.index + passed[0].length).split(/\s+/).some(t => t && !t.startsWith('-'))) return null;
    // npm hands everything after `--` to the END of the script.
    const withFiles = passed ? `${last} ${quoted}` : `${last} -- ${quoted}`;
    return [...parts.slice(0, -1), withFiles].join(' && ');
  }
  if (!runnerWithoutTargets(last)) return null;
  return [...parts.slice(0, -1), `${last} ${quoted}`].join(' && ');
}

/**
 * A known runner that names no targets of its own. With targets, the files
 * handed to it could be ones the configured command never runs (pytest and
 * `node --test` run any path they are given), so the partial run would count
 * tests the whole suite does not have. `vitest run` is the one word allowed.
 */
function runnerWithoutTargets(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/);
  const at = tokens.findIndex(t => /(^|\/)vitest(\.[cm]?js)?$/.test(t) || /(^|\/)pytest$/.test(t) || t === '--test');
  if (at < 0) return false;
  if (tokens[at] === '--test' && !/(^|\/)node$/.test(tokens[at - 1] ?? '')) return false;
  // A run already narrowed by git state or a shard is not the whole suite's run of those files.
  if (tokens.some(t => /^--(changed|shard|related|onlyChanged|lf|last-failed)(=|$)/.test(t))) return false;
  return tokens.slice(at + 1).every((t, i) => t.startsWith('-') || (i === 0 && t === 'run' && /vitest/.test(tokens[at])));
}
