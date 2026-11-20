/**
 * The shell reporting its own AWS profile and KUBECONFIG (INFRA-425).
 *
 * An `export AWS_PROFILE=...` typed at a prompt changes the shell's memory,
 * not its /proc environ, which is fixed when the process starts. Nothing
 * outside the shell can see it - so the shell says it, with one line in the
 * person's rc file (ENV_REPORT_SNIPPET) that runs before every prompt and only
 * in this app's terminals (TERM_PROGRAM=agenfk).
 *
 * The report is an OSC sequence, which a terminal does not draw:
 *
 *   ESC ] 1337 ; AgenfkEnv=SESSION=<id> US AWS_PROFILE=<v> US KUBECONFIG=<v> BEL
 *
 * SESSION is the terminal's own AGENFK_SESSION, and a report naming any other
 * is ignored: anything the terminal prints - a `cat` of a crafted file, a
 * `git log`, an agent's output - could otherwise forge a staging profile over
 * a shell that is on prod. Text cannot know the random id of the terminal it
 * is shown in; a program started in it can, and is trusted no more than the
 * shell that started it.
 *
 * (US is the unit separator, 0x1F; ST, ESC \, is accepted for BEL.) Read in
 * main, from the same stream the title reader taps, so the renderer never
 * handles it. Values are validated here: a profile is a word, a KUBECONFIG is
 * a path list with no control characters.
 */

export const ENV_REPORT_SNIPPET = [
  '# AgEnFK cockpit: report the AWS profile and KUBECONFIG at each prompt (exit status kept).',
  'if [ "$TERM_PROGRAM" = agenfk ]; then',
  "  __agenfk_env() { local s=$?; printf '\\033]1337;AgenfkEnv=SESSION=%s\\037AWS_PROFILE=%s\\037KUBECONFIG=%s\\007' \"${AGENFK_SESSION:-}\" \"${AWS_PROFILE:-}\" \"${KUBECONFIG:-}\"; return $s; }",
  '  if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__agenfk_env)',
  // A NEWLINE separates it from what is already there: valid after a command,
  // after a trailing `;` (PROMPT_COMMAND="history -a;") and after a newline,
  // where `;` would make `;;` and break the whole PROMPT_COMMAND.
  "  else __agenfk_nl='",
  "'; PROMPT_COMMAND=\"${PROMPT_COMMAND:+$PROMPT_COMMAND$__agenfk_nl}__agenfk_env\"; unset __agenfk_nl; fi",
  'fi',
].join('\n');

export interface EnvReport {
  readonly awsProfile: string;
  readonly kubeconfig: string;
}

const START = '\x1b]1337;AgenfkEnv=';
/** A report longer than this is not one; drop it rather than buffer forever. */
const MAX_REPORT = 8192;
const PROFILE = /^[A-Za-z0-9._-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export class EnvReportReader {
  private carry = '';
  private latest: EnvReport | null = null;

  /** @param session the terminal's AGENFK_SESSION; reports naming another are ignored. */
  constructor(private readonly session: string) {}

  /** Feed terminal output; the latest valid report is kept. */
  feed(data: string): void {
    let text = this.carry + data;
    this.carry = '';
    for (;;) {
      const at = text.indexOf(START);
      if (at < 0) {
        // Keep the longest tail that could be START split across two chunks.
        for (let k = Math.min(text.length, START.length - 1); k > 0; k -= 1) {
          if (START.startsWith(text.slice(text.length - k))) { this.carry = text.slice(text.length - k); break; }
        }
        return;
      }
      const body = at + START.length;
      const bel = text.indexOf('\x07', body);
      const st = text.indexOf('\x1b\\', body);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        this.carry = text.length - at > MAX_REPORT ? '' : text.slice(at);
        return;
      }
      this.parse(text.slice(body, end));
      text = text.slice(end + (end === st ? 2 : 1));
    }
  }

  current(): EnvReport | null {
    return this.latest;
  }

  private parse(body: string): void {
    if (body.length > MAX_REPORT) return;
    const fields = new Map<string, string>();
    for (const part of body.split('\x1f')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
    if (fields.get('SESSION') !== this.session) return;
    const awsProfile = fields.get('AWS_PROFILE') ?? '';
    const kubeconfig = fields.get('KUBECONFIG') ?? '';
    if (!PROFILE.test(awsProfile) || CONTROL.test(kubeconfig)) return;
    this.latest = { awsProfile, kubeconfig };
  }
}
