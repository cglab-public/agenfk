import * as fs from 'fs';
import * as path from 'path';

/**
 * Builds Claude Code session logs the way the harness writes them: a parent
 * `<session>.jsonl` and, per subagent, `<session>/subagents/agent-<id>.jsonl`
 * whose records carry the PARENT's session id plus their own agentId.
 */
export class ClaudeTranscript {
  private lines: string[] = [];
  private static seq = 0;

  constructor(readonly sessionId: string, readonly agentId?: string, readonly cwd = '/repo') {}

  private base(ts: string) {
    return {
      timestamp: ts, sessionId: this.sessionId, cwd: this.cwd,
      ...(this.agentId ? { agentId: this.agentId, isSidechain: true } : { isSidechain: false }),
    };
  }

  /** One model turn; returns its message id (what the stored turn is keyed by). */
  turn(ts: string, content: unknown[] = [{ type: 'text', text: 'ok' }]): string {
    const id = `msg_${this.agentId ?? 'parent'}_${++ClaudeTranscript.seq}`;
    this.lines.push(JSON.stringify({
      type: 'assistant', ...this.base(ts),
      message: { id, model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content },
    }));
    return id;
  }

  /** A Bash call and its reply: the call is a turn of its own. */
  bash(ts: string, command: string, reply: string, replyTs = ts.replace(/\.\d{3}Z$/, '.500Z'), isError = false): string {
    const toolUseId = `toolu_${++ClaudeTranscript.seq}`;
    const id = this.turn(ts, [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }]);
    this.lines.push(JSON.stringify({
      type: 'user', ...this.base(replyTs),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: reply, is_error: isError }] },
    }));
    return id;
  }

  gatekeeper(ts: string, itemRef: string): string {
    return this.bash(ts, `agenfk gatekeeper --intent "work" --item-id ${itemRef}`, `✅ AUTHORIZED (CODING).\n\nTASK: [${itemRef.slice(0, 8)}] t`);
  }

  verify(ts: string, itemRef: string, reply = 'Item is now on REVIEW.'): string {
    return this.bash(ts, `agenfk verify ${itemRef} --evidence "done"`, reply);
  }

  /** Where the harness keeps this transcript under a projects folder. */
  pathIn(projectDir: string): string {
    return this.agentId
      ? path.join(projectDir, this.sessionId, 'subagents', `agent-${this.agentId}.jsonl`)
      : path.join(projectDir, `${this.sessionId}.jsonl`);
  }

  private spawner?: string;

  /**
   * GH-400: this subagent was spawned by another subagent, not by the session
   * itself. The harness records it in `agent-<id>.meta.json` beside the log.
   */
  spawnedBy(parentAgentId: string): this {
    this.spawner = parentAgentId;
    return this;
  }

  writeTo(projectDir: string): string {
    const p = this.pathIn(projectDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.lines.join('\n') + '\n');
    if (this.agentId) {
      const meta = { agentType: 'Explore', isBuiltIn: true, ...(this.spawner ? { parentAgentId: this.spawner, spawnDepth: 2 } : { spawnDepth: 1 }) };
      fs.writeFileSync(p.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
    }
    return p;
  }
}
