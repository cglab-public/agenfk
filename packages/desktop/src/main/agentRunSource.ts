/**
 * Where an agent's session file will be, as a GLOB keyed on the session id.
 *
 * The tailer follows `sourcePath`, and a run has to be registered BEFORE the
 * agent writes anything - pi mints the timestamp in its filename at launch, so
 * the concrete path is not knowable yet. So the run carries a PATTERN and
 * `resolveSourcePath` resolves it to the newest match once the file exists.
 *
 * WHY THIS IS THE MISSING LINK (BUG 53ed7163). Everything either side of it was
 * built: the tailer polls `listAgentRuns({status:'running'})`, the parser reads
 * pi's JSONL, the panel renders the events. Nothing ever registered a run, so
 * the feed was correctly empty forever - "complete on both ends, disconnected
 * in the middle", the shape this epic keeps finding.
 *
 * A wrong pattern is not dangerous, it is silent: the tailer finds no file and
 * the run stays eventless. So each shape is written from the parser's own
 * documentation of where the harness puts its sessions.
 */

/** The pi session JSONL: `~/.pi/agent/sessions/<project>/<ts>_<session-id>.jsonl`. */
const PI_PATTERN = (sessionId: string): string => `~/.pi/agent/sessions/*/*_${sessionId}.jsonl`;

/** Claude Code's transcript: `~/.claude/projects/<slug>/<session-id>.jsonl`. */
const CLAUDE_PATTERN = (sessionId: string): string => `~/.claude/projects/*/${sessionId}.jsonl`;

export function agentRunSourcePath(agentId: string, sessionId: string | undefined): string | undefined {
  // No id, no transcript to follow. The run is still worth registering - the
  // panel shows the dispatch - it just cannot be tailed.
  if (!sessionId) return undefined;
  switch (agentId) {
    case 'pi':
      return PI_PATTERN(sessionId);
    case 'claude-code':
      return CLAUDE_PATTERN(sessionId);
    default:
      /*
       * codex and gemini resume by directory rather than by an id we mint, so
       * there is no filename to key on. Undefined rather than a guess: a
       * pattern that matches nothing looks identical to a run that produced no
       * output, and the two are worth telling apart.
       */
      return undefined;
  }
}
