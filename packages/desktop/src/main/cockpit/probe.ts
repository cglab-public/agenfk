/**
 * The probe: what a terminal's directory and its shell say, in one shell run
 * (INFRA-425).
 *
 * Run where the terminal runs (the local shell, or the WSL distro) with the
 * terminal's directory as cwd. A FIXED script: everything it is told arrives
 * as positional arguments, and the only values that leave it are named below.
 *
 *   $1  the terminal's marker (AGENFK_SESSION)
 *   $2  where the AWS profile and KUBECONFIG come from:
 *         reported  $3 and $4, which the terminal's own shell reported (shell
 *                   integration, envReport.ts) - the only source that sees an
 *                   `export` typed at a prompt
 *         scan      the shell's own start environment
 *         none      neither (a tmux-persisted terminal, whose panes share one
 *                   server's environment and would show another card's)
 *       In reported and scan alike, a command running in FRONT of the shell
 *       wins: `AWS_PROFILE=x terraform apply` runs with x whatever the shell
 *       says. The terminal's shell is the oldest process carrying its marker;
 *       its tpgid names what runs in front.
 *   $3 $4  the reported values, '-' for empty (wsl.exe may drop an empty one)
 *
 * Output, one line each: cwd (physical, as agents name their project
 * directories), git (branch, dirty, behind, ahead), tf, aws (profile, the
 * x_security_token_expires saml2aws writes for it, and which source said so),
 * k8s (current-context of the first KUBECONFIG file that names one; only when
 * the terminal's KUBECONFIG is known). NEVER any other variable or credential
 * line: every environment read matches a whole NUL-terminated record by name.
 */

export const COCKPIT_PROBE_SCRIPT = [
  "marker=$1; mode=$2; rprof=$3; rkube=$4",
  "[ \"$rprof\" = - ] && rprof=\"\"",
  "[ \"$rkube\" = - ] && rkube=\"\"",
  "printf \"cwd=%s\\n\" \"$(pwd -P)\"",
  "if b=$(git symbolic-ref --short HEAD 2>/dev/null); then",
  "  if git diff --quiet --ignore-submodules HEAD 2>/dev/null; then d=0; else d=1; fi",
  "  ab=$(git rev-list --left-right --count \"@{u}...HEAD\" 2>/dev/null) || ab=\"\"",
  "  printf \"git=%s\\t%s\\t%s\\n\" \"$b\" \"$d\" \"$ab\"",
  "fi",
  "[ -f .terraform/environment ] && printf \"tf=%s\\n\" \"$(head -n 1 .terraform/environment | tr -d \"\\r\")\"",
  "prof=\"\"; kc=\"\"; src=\"\"; known=0",
  "if [ \"$mode\" = reported ]; then prof=$rprof; kc=$rkube; src=reported; known=1; fi",
  "if [ \"$mode\" != none ]; then",
  "  shell=\"\"",
  "  for f in $(grep -lzxF \"AGENFK_SESSION=$marker\" /proc/[0-9]*/environ 2>/dev/null); do",
  "    p=${f#/proc/}; p=${p%/environ}",
  "    if [ -z \"$shell\" ] || [ \"$p\" -lt \"$shell\" ]; then shell=$p; fi",
  "  done",
  "  if [ -n \"$shell\" ]; then",
  "    st=$(cat \"/proc/$shell/stat\" 2>/dev/null); st=${st##*) }",
  "    set -- $st; fg=$6",
  "    use=\"\"",
  "    if [ -n \"$fg\" ] && [ \"$fg\" -gt 0 ] 2>/dev/null && [ \"$fg\" != \"$shell\" ] && grep -qzxF \"AGENFK_SESSION=$marker\" \"/proc/$fg/environ\" 2>/dev/null; then",
  "      use=$fg; src=foreground",
  "    elif [ \"$mode\" = scan ]; then",
  "      use=$shell; src=shell",
  "    fi",
  "    if [ -n \"$use\" ]; then",
  "      prof=$(grep -zx \"AWS_PROFILE=.*\" \"/proc/$use/environ\" 2>/dev/null | tr \"\\000\" \"\\n\" | sed -n \"1s/^AWS_PROFILE=//p\")",
  "      kc=$(grep -zx \"KUBECONFIG=.*\" \"/proc/$use/environ\" 2>/dev/null | tr \"\\000\" \"\\n\" | sed -n \"1s/^KUBECONFIG=//p\")",
  "      known=1",
  "    fi",
  "  fi",
  "fi",
  "case \"$prof\" in *[!A-Za-z0-9._-]*) prof=\"\" ;; esac",
  "if [ -n \"$prof\" ]; then",
  "  exp=$(awk -v s=\"[$prof]\" '{sub(/\\r$/,\"\")} /^\\[/{f=($0==s)} f && /^x_security_token_expires[ \\t]*=/{sub(/^[^=]*=[ \\t]*/,\"\"); print; exit}' \"$HOME/.aws/credentials\" 2>/dev/null)",
  "  printf \"aws=%s\\t%s\\t%s\\n\" \"$prof\" \"$exp\" \"$src\"",
  "fi",
  "if [ \"$known\" = 1 ]; then",
  "  list=${kc:-$HOME/.kube/config}",
  "  set -f; old_ifs=$IFS; IFS=:",
  "  for kf in $list; do",
  "    IFS=$old_ifs",
  "    [ -f \"$kf\" ] || continue",
  "    ctx=$(sed -n \"s/^current-context:[ ]*//p\" \"$kf\" | head -n 1 | tr -d \"\\\"'\\r\")",
  "    if [ -n \"$ctx\" ]; then printf \"k8s=%s\\n\" \"$ctx\"; break; fi",
  "  done",
  "  IFS=$old_ifs; set +f",
  "fi",
  "exit 0",
].join('\n');

export type AwsSource = 'reported' | 'foreground' | 'shell';

export interface ProbeResult {
  readonly git: { branch: string; dirty: boolean; ahead: number; behind: number } | null;
  readonly tf: string | null;
  readonly aws: { profile: string; expires: string | null; source?: AwsSource } | null;
  readonly k8s: string | null;
  /** The physical working directory, as the agents name their project directories. */
  readonly cwd: string | null;
}

export function parseCockpitProbe(output: string): ProbeResult {
  let git: ProbeResult['git'] = null;
  let tf: string | null = null;
  let aws: ProbeResult['aws'] = null;
  let k8s: string | null = null;
  let cwd: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'git') {
      const [branch, dirty, behind, ahead] = value.split('\t');
      if (branch) git = { branch, dirty: dirty === '1', ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
    } else if (key === 'tf') {
      tf = value.trim() || 'default';
    } else if (key === 'aws') {
      const [profile, expires, source] = value.split('\t');
      const from = source?.trim();
      if (profile) {
        aws = {
          profile, expires: expires?.trim() || null,
          ...(from === 'reported' || from === 'foreground' || from === 'shell' ? { source: from } : {}),
        };
      }
    } else if (key === 'cwd') {
      cwd = value.trim() || null;
    } else if (key === 'k8s') {
      k8s = value.trim() || null;
    }
  }
  return { git, tf, aws, k8s, cwd };
}
