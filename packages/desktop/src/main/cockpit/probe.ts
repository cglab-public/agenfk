/**
 * The probe: what a terminal's directory and its shell say, in one shell run
 * (INFRA-425).
 *
 * Run where the terminal runs (the local shell, or the WSL distro) with the
 * terminal's start directory as cwd. A FIXED script: everything it is told arrives
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
 *   $5 $6  the reported TF_WORKSPACE and TF_DATA_DIR, likewise; '?' when the
 *          shell did not report them (a snippet from before they existed)
 *
 * Where the shell stands: git and Terraform describe the shell's CURRENT
 * directory (/proc/<pid>/cwd), and are left out - unknown - when it cannot be
 * read: no /proc (macOS), no process with the marker, a deleted directory.
 * The same holds for AWS and kube by scan, which read only /proc: on macOS
 * they are unknown too, and only a shell that reports shows them.
 *
 * Output, one line each: cwd (physical, as agents name their project
 * directories), git (branch, dirty, behind, ahead), tf, aws (profile, the
 * x_security_token_expires saml2aws writes for it, and which source said so),
 * k8s (current-context of the first KUBECONFIG file that names one; only when
 * the terminal's KUBECONFIG is known). NEVER any other variable or credential
 * line: every environment read matches a whole NUL-terminated record by name.
 */

export const COCKPIT_PROBE_SCRIPT = [
  "marker=$1; mode=$2; rprof=$3; rkube=$4; rtfw=$5; rtfd=$6",
  "[ \"$rprof\" = - ] && rprof=\"\"",
  "[ \"$rkube\" = - ] && rkube=\"\"",
  "[ \"$rtfw\" = - ] && rtfw=\"\"",
  "[ \"$rtfd\" = - ] && rtfd=\"\"",
  "start=$(pwd -P)",
  "printf \"cwd=%s\\n\" \"$start\"",
  // The terminal's shell: the oldest process carrying its marker. Found first,
  // because where it stands decides which directory the git and Terraform
  // gadgets describe. Without /proc (macOS) or with no such process, it is not
  // found, and nothing below is read from the environment of any process.
  "shell=\"\"; fgp=\"\"",
  "if [ \"$mode\" != none ]; then",
  "  for f in $(grep -lzxF \"AGENFK_SESSION=$marker\" /proc/[0-9]*/environ 2>/dev/null); do",
  "    p=${f#/proc/}; p=${p%/environ}",
  "    if [ -z \"$shell\" ] || [ \"$p\" -lt \"$shell\" ]; then shell=$p; fi",
  "  done",
  "  if [ -n \"$shell\" ]; then",
  "    st=$(cat \"/proc/$shell/stat\" 2>/dev/null); st=${st##*) }",
  "    set -- $st; fg=$6",
  "    if [ -n \"$fg\" ] && [ \"$fg\" -gt 0 ] 2>/dev/null && [ \"$fg\" != \"$shell\" ] && grep -qzxF \"AGENFK_SESSION=$marker\" \"/proc/$fg/environ\" 2>/dev/null; then fgp=$fg; fi",
  "  fi",
  "fi",
  // One whole NAME= record of a process's environment, nothing else.
  "getenv() { grep -zx \"$2=.*\" \"/proc/$1/environ\" 2>/dev/null | tr \"\\000\" \"\\n\" | sed -n \"1s/^$2=//p\"; }",
  // The shell's CURRENT directory, not the one the terminal started in. Not
  // established (no shell found, a deleted directory): git and Terraform stay
  // unknown rather than describe a directory the shell may have left.
  // Every git call: the repository is whatever directory the shell stands in
  // (an extracted archive included), and its own config must not run a command
  // (core.fsmonitor) or a hook on a poll nobody asked for. Ownership checks stay.
  "g() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks \"$@\"; }",
  "tracked=0",
  "if [ -n \"$shell\" ]; then",
  "  t=$(readlink \"/proc/$shell/cwd\" 2>/dev/null)",
  "  if [ -n \"$t\" ] && cd \"$t\" 2>/dev/null; then tracked=1; fi",
  "fi",
  "if [ \"$tracked\" = 1 ]; then",
  "  printf \"track=1\\n\"",
  "  if b=$(g symbolic-ref --short HEAD 2>/dev/null); then",
  // status, not diff: an untracked file is a dirty tree too. But status runs the
  // repository's clean/process filters on any file it must compare, and the
  // shell may have walked into a checkout nobody vetted ($HOME is a start
  // directory too). So it is asked only in the repository the terminal was
  // opened in - the one the cockpit always read. Anywhere else dirty is '?'
  // (unknown). rev-parse, symbolic-ref and rev-list run no filters, hooks or
  // fsmonitor.
  "    top_cur=$(g rev-parse --show-toplevel 2>/dev/null); top_start=$(cd \"$start\" && g rev-parse --show-toplevel 2>/dev/null)",
  "    if [ -n \"$top_cur\" ] && [ \"$top_cur\" = \"$top_start\" ]; then",
  "      if [ -n \"$(g status --porcelain --untracked-files=normal --ignore-submodules 2>/dev/null | head -n 1)\" ]; then d=1; else d=0; fi",
  "    else d='?'; fi",
  "    ab=$(g rev-list --left-right --count \"@{u}...HEAD\" 2>/dev/null) || ab=\"\"",
  "    printf \"git=%s\\t%s\\t%s\\n\" \"$b\" \"$d\" \"$ab\"",
  "  fi",
  // Terraform's own order: TF_WORKSPACE, else the file under TF_DATA_DIR. The
  // variables come from the same place as AWS_PROFILE: what the shell reported,
  // else the start environment of the shell, and a command in front wins.
  "  tfw=\"\"; tfd=\"\"; tfk=0",
  "  if [ \"$mode\" = reported ] && [ \"$rtfw\" != '?' ]; then tfw=$rtfw; tfd=$rtfd; tfk=1",
  "  elif [ \"$mode\" != none ]; then tfw=$(getenv \"$shell\" TF_WORKSPACE); tfd=$(getenv \"$shell\" TF_DATA_DIR); tfk=1; fi",
  "  if [ -n \"$fgp\" ]; then tfw=$(getenv \"$fgp\" TF_WORKSPACE); tfd=$(getenv \"$fgp\" TF_DATA_DIR); tfk=1; fi",
  "  case \"$tfw\" in *[!A-Za-z0-9._-]*) tfk=0 ;; esac",
  "  if [ \"$tfk\" = 1 ]; then",
  "    if [ -n \"$tfw\" ]; then printf \"tf=%s\\n\" \"$tfw\"",
  "    elif [ -f \"${tfd:-.terraform}/environment\" ]; then printf \"tf=%s\\n\" \"$(head -n 1 \"${tfd:-.terraform}/environment\" | tr -d \"\\r\")\"; fi",
  "  fi",
  "fi",
  "prof=\"\"; kc=\"\"; src=\"\"; known=0",
  "if [ \"$mode\" = reported ]; then prof=$rprof; kc=$rkube; src=reported; known=1; fi",
  "use=\"\"",
  "if [ -n \"$fgp\" ]; then use=$fgp; src=foreground",
  "elif [ \"$mode\" = scan ] && [ -n \"$shell\" ]; then use=$shell; src=shell; fi",
  "if [ -n \"$use\" ]; then",
  "  prof=$(getenv \"$use\" AWS_PROFILE)",
  "  kc=$(getenv \"$use\" KUBECONFIG)",
  "  known=1",
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
  readonly git: { branch: string; /** null: not asked, because the directory is outside where the terminal was opened. */ dirty: boolean | null; ahead: number; behind: number } | null;
  readonly tf: string | null;
  readonly aws: { profile: string; expires: string | null; source?: AwsSource } | null;
  readonly k8s: string | null;
  /** The physical directory the terminal STARTED in, as the agents name their project directories. */
  readonly cwd: string | null;
  /** git and tf describe the shell's CURRENT directory; false when it could not be established. */
  readonly tracked: boolean;
}

export function parseCockpitProbe(output: string): ProbeResult {
  let git: ProbeResult['git'] = null;
  let tf: string | null = null;
  let aws: ProbeResult['aws'] = null;
  let k8s: string | null = null;
  let cwd: string | null = null;
  let tracked = false;
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === 'git') {
      const [branch, dirty, behind, ahead] = value.split('\t');
      if (branch) git = { branch, dirty: dirty === '?' ? null : dirty === '1', ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
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
    } else if (key === 'track') {
      tracked = value.trim() === '1';
    } else if (key === 'k8s') {
      k8s = value.trim() || null;
    }
  }
  return { git, tf, aws, k8s, cwd, tracked };
}
