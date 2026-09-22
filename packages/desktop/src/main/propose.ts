/**
 * Asking an agent for a decomposition, once, and returning what it said.
 *
 * NOT A TERMINAL. The first version of this opened an interactive session in a
 * pty, wrote the contract into it and read the answer back out of the terminal
 * scroll — ANSI, prompt and all — for a question that has exactly one answer
 * and no follow-up. The user put it plainly: bringing back the answer of a
 * subprocess is all this is.
 *
 * The renderer still sends ids and a sentence, never a path and never a
 * command: which agent to run is looked up here, from the same descriptors the
 * terminal uses, and the working directory is resolved here too.
 */
import type { AgentPrintCommand } from './agents';

export interface ProposeRequest {
  readonly projectId: string;
  readonly agentId: string;
  readonly objective: string;
}

export interface ProposeDeps {
  /** Where the agent runs: the project's own checkout, never a card worktree. */
  readonly resolveProjectCwd: (projectId: string) => Promise<{ cwd: string }>;
  /** The contract text, which lives in core and is served by the API. */
  readonly fetchContract: (objective: string) => Promise<string>;
  /** How to ask this agent one question, or null when it cannot be asked. */
  readonly printCommand: (agentId: string, prompt: string) => AgentPrintCommand | null;
  readonly run: (
    file: string,
    args: readonly string[],
    opts: { cwd: string; timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * How long one proposal may take.
 *
 * Generous, because a model thinking about a whole objective is not fast, and
 * bounded, because a hung CLI would otherwise leave the screen waiting with a
 * spinner and no way to tell the difference from a slow answer.
 */
export const PROPOSE_TIMEOUT_MS = 5 * 60_000;

export async function proposeDecomposition(
  req: ProposeRequest,
  deps: ProposeDeps,
): Promise<{ stdout: string }> {
  const objective = (req.objective ?? '').trim();
  if (!objective) throw new Error('An objective is required.');

  const contract = await deps.fetchContract(objective);
  const command = deps.printCommand(req.agentId, contract);
  if (!command) {
    // Named, not generic: "cannot" sends someone looking for a bug, while the
    // agent's own name sends them to pick another one.
    throw new Error(`${req.agentId} cannot be asked a single question — it has no non-interactive mode here.`);
  }

  const { cwd } = await deps.resolveProjectCwd(req.projectId);
  const { stdout, stderr } = await deps.run(command.file, command.args, {
    cwd,
    timeoutMs: PROPOSE_TIMEOUT_MS,
  });

  /*
   * An agent that printed nothing is a failure even when the process exited
   * zero — and its stderr is the only thing that explains why (not logged in,
   * rate limited, model unavailable). Passing back an empty string would make
   * the screen say "no proposal found", which blames the answer instead of the
   * run.
   */
  if (!stdout.trim()) {
    const why = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(why ? `The agent printed nothing. It said: ${why}` : 'The agent printed nothing.');
  }
  return { stdout };
}
