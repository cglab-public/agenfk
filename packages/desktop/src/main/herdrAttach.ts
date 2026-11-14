/**
 * Attaching to herdr, the way this app already attaches to tmux.
 *
 * herdr runs as its own daemon and owns the agent processes; our PTY is only a
 * view onto them. That is the same relationship tmux.ts describes, and it is
 * why attaching is a shell line rather than a protocol: the terminal this app
 * already has is the right surface, and there is nothing to build.
 *
 * This replaced a read-only mirror with a keypad, modelled on collie. collie is
 * a BRIDGE - you point a phone at it - and between a phone and a session there
 * is no PTY to be had, so a photograph is the best it can do. We are on the
 * same machine as the daemon. Copying its architecture imported a constraint
 * that was never ours, next to a tmux attach doing the identical job.
 *
 * One difference from tmux, and it decides whether this works at all: herdr
 * refuses to run inside herdr. MEASURED - spawning it from a pane answers
 * "nested herdr is disabled by default" and exits. Anything this app launches
 * from a terminal that is itself a herdr pane inherits HERDR_PANE_ID and dies
 * the same way, so the variables are stripped rather than trusted.
 */

/** Only names this module generates. Anything else is refused, not quoted. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * herdr marks its panes in the environment, and checks for those marks on
 * startup. Inheriting them is the difference between a terminal and a refusal.
 */
export function envWithoutHerdr(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.toUpperCase().startsWith('HERDR')) out[k] = v;
  }
  return out;
}

/**
 * The shell line that attaches to a running herdr session.
 *
 * Unlike tmux there is no `ensure` step for the default session: herdr is
 * already up, holding the panes we are attaching to. A NAMED session is
 * created-or-attached by herdr itself, so the same line covers both.
 *
 * Passing no name attaches to the persistent default session - the one
 * `herdr session list` calls `default`, and the one an operator's own window
 * is already looking at.
 */
export function buildHerdrAttachCommand(sessionName?: string): string {
  if (sessionName === undefined) return 'herdr';
  if (!SAFE_NAME.test(sessionName)) {
    // It reaches a shell line. Accepting an arbitrary name would be command
    // injection with extra steps, so it is refused rather than escaped.
    throw new Error(`Refusing an unrecognised herdr session name: ${JSON.stringify(sessionName)}`);
  }
  return `herdr --session ${quote(sessionName)}`;
}

/**
 * What a second client costs, stated rather than discovered.
 *
 * MEASURED on a throwaway session: a second client IS accepted, and the first
 * redrew when it joined. herdr's grid is per session, not per client, so
 * attaching from a narrow panel reflows the operator's own window to match -
 * the tmux behaviour of clamping to the smallest client. It is recoverable and
 * it is not a surprise worth hiding, so the UI says it before opening one.
 */
export const HERDR_SECOND_CLIENT_NOTE =
  'herdr shares one layout between every attached client, so opening this here '
  + 'may resize the herdr window you already have open.';

/**
 * The command a PTY runs to attach.
 *
 * Shaped like an agent's descriptor so the spawn path can hold one variable
 * for both, but it comes from HERE rather than from the agent table - see
 * HERDR_AGENT_ID for why that table must not carry it.
 */
export function herdrAttachCommand(sessionName?: string): { file: string; args: readonly string[] } {
  return sessionName === undefined
    ? { file: 'herdr', args: [] }
    // Built through the same gate as the shell line, so an unrecognised name is
    // refused on this route too rather than only on the other one.
    : { file: 'herdr', args: buildHerdrAttachCommand(sessionName).split(' ').slice(1).map(a => a.replace(/^'|'$/g, '')) };
}
