/**
 * Behaviour tests for the test-guard PreToolUse hook (bin/agenfk-test-guard.mjs).
 *
 * The guard exists so an agent can never quietly rewrite, relax, skip or delete
 * a test that already exists to make a red suite go green — the developer gets
 * the call: accept the test change, or keep the test and fix the code. The
 * behaviours worth pinning are therefore (a) it recognises test files across
 * ecosystems, (b) it stays silent for new tests and pure additions, and (c) it
 * asks — never hard-blocks — when existing test code is rewritten.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-ignore — .mjs hook has no .d.ts; these are plain JS exports.
import {
  isTestFile,
  classifyEdit,
  classifyToolCall,
  classifyBashCommand,
  buildDirective,
} from '../../../../bin/agenfk-test-guard.mjs';

const HOOK = path.resolve(__dirname, '../../../../bin/agenfk-test-guard.mjs');

function runHook(payload: unknown, client = 'claude-code'): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, '--client', client]);
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (status) => resolve({ status, stdout }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('isTestFile', () => {
  it.each([
    'packages/server/src/test/foo.test.ts',
    'src/Button.spec.tsx',
    'api/tests/test_users.py',
    'api/users_test.py',
    'internal/store/store_test.go',
    'spec/models/user_spec.rb',
    'src/main/java/com/x/UserTest.java',
    'src/test/java/com/x/Helpers.java',
    'apps/web/__tests__/helpers.ts',
  ])('recognises %s as test code', (p) => {
    expect(isTestFile(p)).toBe(true);
  });

  it.each([
    'packages/server/src/routes/items.ts',
    'README.md',
    'docs/tests/overview.md',      // test-named dir, but not code
    'src/latest.ts',               // 'test' only as a substring
    '',
  ])('does not flag %s', (p) => {
    expect(isTestFile(p as string)).toBe(false);
  });

  it('handles Windows-style separators', () => {
    expect(isTestFile('packages\\server\\src\\test\\foo.ts')).toBe(true);
  });
});

describe('classifyEdit', () => {
  it('allows a pure insertion (no old text)', () => {
    expect(classifyEdit('', 'it("new case", () => {})')).toBeNull();
  });

  it('allows an append that keeps the existing text verbatim', () => {
    const before = 'it("a", () => expect(x).toBe(1));';
    expect(classifyEdit(before, `${before}\nit("b", () => expect(y).toBe(2));`)).toBeNull();
  });

  it('asks when an existing assertion is rewritten', () => {
    expect(classifyEdit('expect(x).toBe(1)', 'expect(x).toBe(2)')).toMatch(/rewrites/);
  });

  it('asks when existing test code is deleted', () => {
    expect(classifyEdit('it("a", () => expect(x).toBe(1));', '')).toMatch(/deletes/);
  });

  it.each([
    ['it("a", () => {})', 'it.skip("a", () => {})'],
    ['def test_a():', '@pytest.mark.skip\ndef test_a():'],
    ['@Test\npublic void a() {}', '@Ignore\n@Test\npublic void a() {}'],
    ['func TestA(t *testing.T) {', 'func TestA(t *testing.T) {\n\tt.Skip("flaky")'],
  ])('asks when a skip marker is introduced (%#)', (before, after) => {
    expect(classifyEdit(before, after)).toMatch(/disables a test/);
  });
});

describe('classifyToolCall', () => {
  it('ignores non-test files entirely', () => {
    expect(classifyToolCall('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, true)).toBeNull();
  });

  it('ignores a brand-new test file (nothing exists to protect)', () => {
    expect(classifyToolCall('Write', { file_path: 'src/app.test.ts', content: 'x' }, false)).toBeNull();
  });

  it('asks when an existing test file is overwritten wholesale', () => {
    const verdict = classifyToolCall('Write', { file_path: 'src/app.test.ts', content: 'x' }, true);
    expect(verdict?.reason).toMatch(/overwrites/);
  });

  it('asks when any one edit in a MultiEdit batch rewrites existing test code', () => {
    const verdict = classifyToolCall('Edit', {
      file_path: 'src/app.test.ts',
      edits: [
        { old_string: 'a', new_string: 'a\nb' },       // additive — fine on its own
        { old_string: 'toBe(1)', new_string: 'toBe(2)' }, // this one decides
      ],
    }, true);
    expect(verdict?.reason).toMatch(/rewrites/);
  });

  it('allows a notebook cell insert but asks on replace', () => {
    expect(classifyToolCall('NotebookEdit', { notebook_path: 'tests/a.test.ipynb', edit_mode: 'insert' }, true)).toBeNull();
    expect(classifyToolCall('NotebookEdit', { notebook_path: 'tests/a.test.ipynb', edit_mode: 'replace' }, true)?.reason)
      .toMatch(/replaces a cell/);
  });
});

describe('classifyBashCommand', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-test-guard-'));
  const testFile = path.join(dir, 'thing.test.ts');
  const srcFile = path.join(dir, 'thing.ts');

  beforeAll(() => {
    fs.writeFileSync(testFile, 'it("a", () => {});');
    fs.writeFileSync(srcFile, 'export const a = 1;');
  });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('asks when an existing test file is rm-ed', () => {
    expect(classifyBashCommand(`rm ${testFile}`)?.reason).toMatch(/deletes an existing test file/);
    expect(classifyBashCommand(`git rm -f "${testFile}"`)?.reason).toMatch(/deletes an existing test file/);
  });

  it('ignores rm of non-test files and unrelated commands', () => {
    expect(classifyBashCommand(`rm ${srcFile}`)).toBeNull();
    expect(classifyBashCommand('npm test')).toBeNull();
    expect(classifyBashCommand(`cat ${testFile}`)).toBeNull();
  });

  it('ignores a path that does not exist (nothing to protect)', () => {
    expect(classifyBashCommand(`rm ${path.join(dir, 'ghost.test.ts')}`)).toBeNull();
  });
});

describe('buildDirective', () => {
  it('asks — never blocks — on Claude Code, so the developer answers inline', () => {
    const directive = buildDirective('claude-code', 'because');
    expect(directive.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(directive.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(directive.hookSpecificOutput.permissionDecisionReason).toBe('because');
    expect(JSON.stringify(directive)).not.toContain('"deny"');
  });

  it('carries the reason for every other client shape', () => {
    for (const client of ['codex', 'gemini', 'cursor', 'opencode', 'pi', 'unknown']) {
      expect(JSON.stringify(buildDirective(client, 'because'))).toContain('because');
    }
  });
});

describe('the hook end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-test-guard-e2e-'));
  const testFile = path.join(dir, 'thing.test.ts');

  beforeAll(() => { fs.writeFileSync(testFile, 'it("a", () => expect(x).toBe(1));'); });
  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('asks the developer when an existing test is rewritten, offering both options', async () => {
    const { status, stdout } = await runHook({
      tool: 'Edit',
      tool_input: { file_path: testFile, old_string: 'toBe(1)', new_string: 'toBe(2)' },
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('ACCEPT the test change');
    expect(reason).toContain('KEEP the test as-is and fix the production code');
  });

  it('stays silent when new test cases are appended', async () => {
    const before = 'it("a", () => expect(x).toBe(1));';
    const { status, stdout } = await runHook({
      tool: 'Edit',
      tool_input: { file_path: testFile, old_string: before, new_string: `${before}\nit("b", () => {});` },
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('stays silent for production code', async () => {
    const { stdout } = await runHook({
      tool: 'Edit',
      tool_input: { file_path: path.join(dir, 'thing.ts'), old_string: 'a', new_string: 'b' },
    });
    expect(stdout.trim()).toBe('');
  });
});
