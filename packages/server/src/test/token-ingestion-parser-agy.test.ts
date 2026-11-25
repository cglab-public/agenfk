import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';
import type { TokenEvent, IngestionState } from '@agenfk/core';
import { parseAgyJsonl, resolveAgyCwd } from '../token-ingestion/parsers/agy';
import { ingestOnce, processFile, type ParserContext } from '../token-ingestion/watcher';
import { defaultIngestionSources } from '../token-ingestion/service';

const CONV_ID = '8eef666a-e63e-48e3-a051-a5ad49e5224b';
const SRC_PATH = `/home/u/.gemini/antigravity-cli/brain/${CONV_ID}/.system_generated/logs/transcript.jsonl`;

const plannerLine = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-23T20:17:03Z',
    model: 'gemini-4-neon-medium',
    input_tokens: 13950,
    cache_read_tokens: 11519,
    output_tokens: 475,
    ...overrides,
  });

describe('parseAgyJsonl', () => {
  it('parses PLANNER_RESPONSE token usage and skips non-planner or zero-token records', () => {
    const text = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-23T20:17:00Z', content: 'hi' }),
      plannerLine({ step_index: 1, input_tokens: 1000, cache_read_tokens: 500, output_tokens: 200 }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-23T20:17:04Z', content: 'tool result' }),
      'not-json-at-all',
      plannerLine({ step_index: 3, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }),
      plannerLine({ step_index: 4, model: 'gemini-3.8-flash-medium', input_tokens: 300, cache_read_tokens: 2000, cache_write_tokens: 100, output_tokens: 50, thinking_tokens: 25 }),
    ].join('\n') + '\n';

    const events = parseAgyJsonl(text, SRC_PATH, 0);
    expect(events).toHaveLength(2);

    expect(events[0]).toMatchObject({
      client: 'agy',
      sessionId: CONV_ID,
      turnId: '1',
      dedupKey: `${CONV_ID}:1`,
      model: 'gemini-4-neon-medium',
      ts: '2026-11-23T20:17:03Z',
      input: 1000,
      cacheRead: 500,
      cacheWrite: 0,
      cachedInput: 500,
      output: 200,
      reasoning: 0,
      total: 1700,
      sourcePath: SRC_PATH,
    });
    expect(events[0].sourceOffset).toBeGreaterThan(0);

    expect(events[1]).toMatchObject({
      client: 'agy',
      sessionId: CONV_ID,
      turnId: '4',
      dedupKey: `${CONV_ID}:4`,
      model: 'gemini-3.8-flash-medium',
      input: 300,
      cacheRead: 2000,
      cacheWrite: 100,
      cachedInput: 2100,
      output: 50,
      reasoning: 25,
      total: 2450,
    });
  });

  it('skips PLANNER_RESPONSE lines that have no token counts (e.g. older IDE logs)', () => {
    const text = JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-05-20T00:48:26Z',
    }) + '\n';

    expect(parseAgyJsonl(text, SRC_PATH, 0)).toEqual([]);
  });

  it('extracts TranscriptClaims only after tool results confirm gatekeeper authorization', () => {
    const cardA = 'e83fdf88-a2a0-49e3-bbd3-6a67335affe6';
    const cardB = '6e87f08b-9bb7-4b20-92fa-027ec17bfff8';
    const cardC = 'fb71e84a-45db-4933-adc7-131bd5d44b49';
    const cardRejected = '11111111-2222-3333-4444-555555555555';
    const text = [
      // Lazy MCP validate_progress (real advance) + dry-run plan (must be ignored)
      plannerLine({
        step_index: 10,
        created_at: '2026-11-23T20:19:27Z',
        tool_calls: [
          {
            name: 'call_mcp_tool',
            args: {
              ServerName: '"agenfk"',
              ToolName: '"validate_progress"',
              Arguments: JSON.stringify({ itemId: cardA, evidence: 'done' }),
            },
          },
          {
            name: 'call_mcp_tool',
            args: {
              ServerName: '"agenfk"',
              ToolName: '"validate_progress"',
              Arguments: JSON.stringify({ itemId: cardB, plan: true }),
            },
          },
        ],
      }),
      JSON.stringify({ step_index: 11, type: 'GENERIC', status: 'DONE', content: '✅ Validation Passed!' }),
      JSON.stringify({ step_index: 12, type: 'GENERIC', status: 'DONE', content: 'plan output' }),
      // Eager MCP workflow_gatekeeper: one authorized (infers card from reply), one rejected
      plannerLine({
        step_index: 13,
        created_at: '2026-11-23T20:20:00Z',
        tool_calls: [
          {
            name: 'mcp_agenfk_workflow_gatekeeper',
            args: { intent: '"code"' },
          },
          {
            name: 'mcp_agenfk_workflow_gatekeeper',
            args: { itemId: JSON.stringify(cardRejected), intent: '"code"' },
          },
        ],
      }),
      JSON.stringify({ step_index: 14, type: 'GENERIC', status: 'DONE', content: `✅ AUTHORIZED.\n\nTASK: [${cardB}] Foo` }),
      JSON.stringify({ step_index: 15, type: 'GENERIC', status: 'DONE', content: '❌ UNAUTHORIZED: card is not active' }),
      // Shell run_command invoking agenfk CLI
      plannerLine({
        step_index: 16,
        created_at: '2026-11-23T20:21:00Z',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: JSON.stringify(`agenfk verify ${cardC} --evidence "ok"`) },
          },
        ],
      }),
      JSON.stringify({ step_index: 17, type: 'GENERIC', status: 'DONE', content: '✅ Validation Passed!' }),
    ].join('\n') + '\n';

    const ctx: ParserContext = { claims: [] };
    parseAgyJsonl(text, SRC_PATH, 0, ctx);

    expect(ctx.claims).toEqual([
      { sessionId: CONV_ID, agentId: '', itemRef: cardA, at: '2026-11-23T20:19:27Z' },
      { sessionId: CONV_ID, agentId: '', itemRef: cardB, at: '2026-11-23T20:20:00Z' },
      { sessionId: CONV_ID, agentId: '', itemRef: cardC, at: '2026-11-23T20:21:00Z' },
    ]);
  });

  it('does not record a gatekeeper claim before its tool result arrives', () => {
    const cardA = 'e83fdf88-a2a0-49e3-bbd3-6a67335affe6';
    const callLine = plannerLine({
      step_index: 10,
      created_at: '2026-11-23T20:19:27Z',
      tool_calls: [{ name: 'mcp_agenfk_workflow_gatekeeper', args: { itemId: JSON.stringify(cardA), intent: '"code"' } }],
    }) + '\n';
    const ctx: ParserContext = { claims: [] };
    parseAgyJsonl(callLine, SRC_PATH, 0, ctx);
    expect(ctx.claims).toEqual([]);

    // Next pass receives the authorization result and emits the claim
    const resultLine = JSON.stringify({ step_index: 11, type: 'GENERIC', status: 'DONE', content: '✅ AUTHORIZED.' }) + '\n';
    ctx.claims = [];
    parseAgyJsonl(resultLine, SRC_PATH, Buffer.byteLength(callLine, 'utf8'), ctx);
    expect(ctx.claims).toEqual([{ sessionId: CONV_ID, agentId: '', itemRef: cardA, at: '2026-11-23T20:19:27Z' }]);
  });

  it('tracks incremental offsets cleanly across processFile passes', () => {
    const first = plannerLine({ step_index: 1 }) + '\n';
    const second = plannerLine({ step_index: 2, created_at: '2026-11-23T20:18:00Z' }) + '\n';

    const r1 = processFile(SRC_PATH, first, null, parseAgyJsonl);
    expect(r1.events).toHaveLength(1);

    const r2 = processFile(SRC_PATH, first + second, r1.nextState, parseAgyJsonl);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].turnId).toBe('2');
  });
});

describe('resolveAgyCwd & end-to-end ingestion with pricing and card attribution', () => {
  let root: string;
  let cliDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-agy-test-'));
    cliDir = path.join(root, '.gemini', 'antigravity-cli');
    transcriptPath = path.join(cliDir, 'brain', CONV_ID, '.system_generated', 'logs', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  });

  it('resolves workspace_uris (including URL-encoded spaces) from conversation_summaries.db', () => {
    const repoPath = path.join(root, 'my repo', 'agenfk');
    const db = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(
      CONV_ID,
      JSON.stringify([pathToFileURL(repoPath).href]),
    );
    db.close();

    expect(resolveAgyCwd(transcriptPath, CONV_ID)).toBe(repoPath);
  });

  it('returns undefined gracefully when conversation_summaries.db is absent and retries on later passes', () => {
    expect(resolveAgyCwd(transcriptPath, CONV_ID)).toBeUndefined();

    // First pass while DB is missing: cwd is undefined and NOT permanently cached as null
    const ctx: ParserContext = { claims: [] };
    const e1 = parseAgyJsonl(plannerLine({ step_index: 1 }) + '\n', transcriptPath, 0, ctx);
    expect(e1[0].cwd).toBeUndefined();

    // DB appears before the next pass
    const lateRepo = path.join(root, 'late-repo');
    const db = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(
      CONV_ID,
      JSON.stringify([pathToFileURL(lateRepo).href]),
    );
    db.close();

    const e2 = parseAgyJsonl(plannerLine({ step_index: 2 }) + '\n', transcriptPath, 200, ctx);
    expect(e2[0].cwd).toBe(lateRepo);
  });

  it('ingests agy transcript via defaultIngestionSources, prices gemini-4-neon-medium, and attributes to claimed card', async () => {
    const cardId = 'e83fdf88-a2a0-49e3-bbd3-6a67335affe6';
    const projectId = 'proj-1';
    const repoRoot = path.join(root, 'repo', 'agenfk');
    const db = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run(
      CONV_ID,
      JSON.stringify([pathToFileURL(repoRoot).href]),
    );
    db.close();

    fs.writeFileSync(
      transcriptPath,
      [
        plannerLine({
          step_index: 1,
          created_at: '2026-11-23T20:17:00Z',
          input_tokens: 1_000_000,
          cache_read_tokens: 0,
          output_tokens: 0,
          tool_calls: [
            {
              name: 'call_mcp_tool',
              args: {
                ServerName: '"agenfk"',
                ToolName: '"workflow_gatekeeper"',
                Arguments: JSON.stringify({ itemId: cardId, intent: 'code' }),
              },
            },
          ],
        }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: '✅ AUTHORIZED.' }),
        plannerLine({
          step_index: 3,
          created_at: '2026-11-23T20:18:00Z',
          input_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
          output_tokens: 1_000_000,
        }),
      ].join('\n') + '\n',
    );

    const inserted: TokenEvent[] = [];
    const claims: Array<{ client: string; sessionId: string; agentId: string; itemId: string; projectId: string; at: string }> = [];
    const states: Record<string, IngestionState> = {};
    const storage: any = {
      async insertTokenEvent(ev: TokenEvent) { inserted.push(ev); },
      async getIngestionState(p: string) { return states[p] ?? null; },
      async setIngestionState(s: IngestionState) { states[s.sourcePath] = s; },
      async listProjects() { return [{ id: projectId, projectRoot: repoRoot }]; },
      async getItem(id: string) { return id === cardId ? { id: cardId, projectId } : null; },
      async listItems() { return [{ id: cardId, projectId }]; },
      async sessionCardAt() { return null; },
      async recordTranscriptClaim(c: any) { claims.push(c); return true; },
      async transcriptCardAt(client: string, sessionId: string, agentId: string, ts: string) {
        const match = claims
          .filter((c) => c.client === client && c.sessionId === sessionId && c.agentId === agentId && c.at <= ts)
          .sort((a, b) => b.at.localeCompare(a.at))[0];
        return match ? { itemId: match.itemId, projectId: match.projectId } : null;
      },
      async firstTranscriptClaim(client: string, sessionId: string, agentId: string) {
        const match = claims
          .filter((c) => c.client === client && c.sessionId === sessionId && c.agentId === agentId)
          .sort((a, b) => a.at.localeCompare(b.at))[0];
        return match ? { itemId: match.itemId, projectId: match.projectId, at: match.at } : null;
      },
      async queryTokenEvents() { return []; },
      async reattributeTranscriptEvents() { return []; },
    };

    const agySources = defaultIngestionSources(root, {}).filter((s) => s.client === 'agy');
    expect(agySources).toHaveLength(2);

    const written = await ingestOnce({
      storage,
      sources: agySources,
      attributeEvents: true,
      prices: async () => ({
        prices: [{ id: 'gemini-4-neon', input: 3, output: 15, input_cached: 0.15 }],
      }),
    });

    expect(written).toBe(2);
    expect(inserted[0].cwd).toBe(repoRoot);
    expect(inserted[0].projectId).toBe(projectId);
    expect(inserted[0].estimatedCostUsd).toBeCloseTo(3);
    // Second turn falls after the workflow_gatekeeper claim and is attributed to cardId
    expect(inserted[1].itemId).toBe(cardId);
    expect(inserted[1].projectId).toBe(projectId);
    expect(inserted[1].estimatedCostUsd).toBeCloseTo(18.15);
  });
});
