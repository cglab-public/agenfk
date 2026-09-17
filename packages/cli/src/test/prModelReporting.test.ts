/**
 * The wiring, not the helper.
 *
 * Every safety rule in harnessModel.ts is worthless if `pr create`,
 * `pr-register` and `pr-resize` don't actually call it — and nothing pinned
 * that: the whole integration could be reverted with the unit tests still green.
 * Commander's negated options are the specific trap, since `--no-detect-model`
 * populates `options.detectModel = false`, and getting that backwards would
 * disable the feature silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveModelForReport, resolveFromOptions } from '../harnessModel';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-prm-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function piSession(cwd: string, modelId: string) {
  const dir = path.join(home, '.pi', 'agent', 'sessions', 's');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), [
    JSON.stringify({ type: 'session', cwd }),
    JSON.stringify({ type: 'model_change', provider: 'coding4', modelId: 'qwen3.8:27b' }),
    JSON.stringify({ type: 'model_change', provider: 'openrouter', modelId }),
  ].join('\n'));
}

/** The option shape the three PR commands declare. */
function parse(argv: string[]) {
  const cmd = new Command()
    .exitOverride()
    .requiredOption('--model <id>', 'model')
    .requiredOption('--harness <name>', 'harness')
    .option('--no-detect-model', 'skip detection');
  cmd.parse(['node', 'x', ...argv]);
  return cmd.opts();
}

describe('--no-detect-model wiring', () => {
  it('leaves detection ON by default', () => {
    // Commander sets detectModel=true when a --no- option is absent. If this
    // ever flipped, every PR would silently go back to the unverified claim.
    expect(parse(['--model', 'm', '--harness', 'pi']).detectModel).toBe(true);
  });

  it('turns detection OFF when the flag is passed', () => {
    expect(parse(['--model', 'm', '--harness', 'pi', '--no-detect-model']).detectModel).toBe(false);
  });

  it('feeds through to resolveModelForReport as an opt-out', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const on = parse(['--model', 'qwen3.8:27b', '--harness', 'pi']);
    const off = parse(['--model', 'qwen3.8:27b', '--harness', 'pi', '--no-detect-model']);
    expect(resolveModelForReport(on.model, { cwd: '/work/proj', home, detect: on.detectModel, harness: on.harness }).model)
      .toBe('deepseek/deepseek-v4.1-flash');
    expect(resolveModelForReport(off.model, { cwd: '/work/proj', home, detect: off.detectModel, harness: off.harness }).model)
      .toBe('qwen3.8:27b');
  });

  it('passes the declared harness through, so a foreign log cannot rewrite it', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'gpt-5.2', '--harness', 'codex']);
    const r = resolveModelForReport(o.model, { cwd: '/work/proj', home, detect: o.detectModel, harness: o.harness });
    expect(r.model).toBe('gpt-5.2');
    expect(r.warning).toMatch(/another harness/);
  });
});

describe('resolveFromOptions — the step each PR command performs', () => {
  it('corrects the model straight from a parsed option object', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'qwen3.8:27b', '--harness', 'pi']);
    const r = resolveFromOptions(o as any, { cwd: '/work/proj', home });
    expect(r.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(r.warning).toBeDefined();
  });

  it('respects --no-detect-model straight from the parsed options', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'qwen3.8:27b', '--harness', 'pi', '--no-detect-model']);
    expect(resolveFromOptions(o as any, { cwd: '/work/proj', home }).model).toBe('qwen3.8:27b');
  });

  it('refuses to rewrite across a harness mismatch, straight from the options', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'gpt-5.2', '--harness', 'codex']);
    expect(resolveFromOptions(o as any, { cwd: '/work/proj', home }).model).toBe('gpt-5.2');
  });

  it('leaves a model alone when no session can be matched, and says it is unverified', () => {
    // Silent fallback to the unverified claim was indistinguishable from a
    // confirmed match, so a reader could not tell which they were looking at.
    const o = parse(['--model', 'gpt-5.2', '--harness', 'codex']);
    const r = resolveFromOptions(o as any, { cwd: '/work/elsewhere', home });
    expect(r.model).toBe('gpt-5.2');
    expect(r.warning).toBeUndefined();
    expect(r.verified).toBe(false);
  });

  it('marks a confirmed match as verified', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'deepseek/deepseek-v4.1-flash', '--harness', 'pi']);
    expect(resolveFromOptions(o as any, { cwd: '/work/proj', home }).verified).toBe(true);
  });

  it('does not claim verification when detection was switched off', () => {
    piSession('/work/proj', 'deepseek/deepseek-v4.1-flash');
    const o = parse(['--model', 'anything', '--harness', 'pi', '--no-detect-model']);
    expect(resolveFromOptions(o as any, { cwd: '/work/proj', home }).verified).toBe(false);
  });
});
