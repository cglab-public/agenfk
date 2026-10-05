/**
 * Tainted format strings in the UI's console calls (CodeQL js/tainted-format-string).
 *
 * `console.error`/`warn`/`log` treat their FIRST argument as a format string.
 * Interpolating an id into it — `console.error(`API Error updating item ${id}:`, e)`
 * — hands the caller control of the directives: an id of `%s%s%s` consumes the
 * arguments that follow, so the error object `e` is absorbed into the formatting
 * and never reaches the log. The operator is left with a line that reads like a
 * report and carries none of the diagnosis.
 *
 * These specs therefore assert the DEFECT, not the wording. A test that only
 * checked the message text passes against the broken code, because the broken
 * code still contains the words. What has to hold is positional: argument 0 must
 * carry no directive it did not intend, and every value handed after it must sit
 * beyond the reach of the directives that are there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { api } from '../api';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

/**
 * The console format directives, minus the escaped `%%`.
 *
 * `%c` is included deliberately: it consumes an argument exactly like `%s` does,
 * which is what makes an id containing `%c` able to steal a style argument.
 */
const DIRECTIVE = /%[sdifoOjc]/g;

function directiveCount(format: unknown): number {
  if (typeof format !== 'string') return 0;
  return (format.replace(/%%/g, '').match(DIRECTIVE) ?? []).length;
}

/**
 * Does `value` reach the log as its own argument, or is it eaten by formatting?
 *
 * The console consumes the trailing arguments left-to-right, one per directive
 * in argument 0. A value survives only if it sits past the last directive that
 * argument 0 declares — being *present* in the arguments array proves nothing,
 * which is exactly why the broken code looks correct at a glance.
 */
function survivesFormatting(args: unknown[], value: unknown): boolean {
  const index = args.indexOf(value);
  if (index < 1) return false; // absent, or passed as the format string itself
  return index > directiveCount(args[0]);
}

/** A value an attacker (or an unlucky uuid) can put where an id is expected. */
const TAINT = '%s%s%s';

interface Case {
  /** Where the call lives, so a failure names the line to fix. */
  readonly what: string;
  /** Text an operator greps for. Must survive the fix. */
  readonly greppable: string;
  /** The axios verb to reject, so the catch block runs. */
  readonly verb: 'get' | 'post' | 'put' | 'delete';
  /** Tainted values this call site interpolates, in order. */
  readonly tainted: readonly string[];
  readonly invoke: (values: readonly string[]) => Promise<unknown>;
}

const CASES: readonly Case[] = [
  { what: 'listAgentRuns', greppable: 'API Error listing agent runs', verb: 'get', tainted: [TAINT], invoke: ([a]) => api.listAgentRuns(a) },
  { what: 'listRunEvents', greppable: 'API Error listing run events', verb: 'get', tainted: [TAINT], invoke: ([a]) => api.listRunEvents(a) },
  { what: 'deleteProject', greppable: 'API Error deleting project', verb: 'delete', tainted: [TAINT], invoke: ([a]) => api.deleteProject(a) },
  { what: 'getItem', greppable: 'API Error getting item', verb: 'get', tainted: [TAINT], invoke: ([a]) => api.getItem(a) },
  { what: 'getGitStatus', greppable: 'API Error reading git status', verb: 'get', tainted: [TAINT], invoke: ([a]) => api.getGitStatus(a) },
  { what: 'forgetTerminalSession', greppable: 'API Error forgetting terminal session', verb: 'delete', tainted: [TAINT], invoke: ([a]) => api.forgetTerminalSession(a) },
  { what: 'updateItem', greppable: 'API Error updating item', verb: 'put', tainted: [TAINT], invoke: ([a]) => api.updateItem(a, {}) },
  { what: 'deleteItem', greppable: 'API Error deleting item', verb: 'delete', tainted: [TAINT], invoke: ([a]) => api.deleteItem(a) },
  { what: 'moveItem', greppable: 'API Error moving item', verb: 'post', tainted: [TAINT, '%d%d'], invoke: ([a, b]) => api.moveItem(a, b) },
  { what: 'trashArchivedItems', greppable: 'API Error trashing archived items', verb: 'post', tainted: [TAINT], invoke: ([a]) => api.trashArchivedItems(a) },
  { what: 'updateFlow', greppable: 'API Error updating flow', verb: 'put', tainted: [TAINT], invoke: ([a]) => api.updateFlow(a, {}) },
  { what: 'deleteFlow', greppable: 'API Error deleting flow', verb: 'delete', tainted: [TAINT], invoke: ([a]) => api.deleteFlow(a) },
  { what: 'setProjectFlow', greppable: 'API Error setting flow for project', verb: 'post', tainted: [TAINT], invoke: ([a]) => api.setProjectFlow(a, 'f1') },
  { what: 'getProjectFlow', greppable: 'API Error getting flow for project', verb: 'get', tainted: [TAINT], invoke: ([a]) => api.getProjectFlow(a) },
  { what: 'selectOrgFlow', greppable: 'API Error selecting org flow for project', verb: 'post', tainted: [TAINT], invoke: ([a]) => api.selectOrgFlow(a, 'f1') },
  { what: 'installFromRegistry', greppable: 'API Error installing flow from registry', verb: 'post', tainted: [TAINT], invoke: ([a]) => api.installFromRegistry(a) },
  { what: 'publishToRegistry', greppable: 'API Error publishing flow', verb: 'post', tainted: [TAINT], invoke: ([a]) => api.publishToRegistry(a) },
];

describe('UI console calls never let caller data become a format string', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  /**
   * The count is asserted so that a new `console.error(`... ${x}`)` added later
   * fails here rather than shipping. It is the whole defect class in api.ts, not
   * only the two lines CodeQL's taint path happened to reach.
   */
  it('covers every interpolating call site in api.ts', () => {
    expect(CASES).toHaveLength(17);
  });

  for (const testCase of CASES) {
    describe(`api.${testCase.what}`, () => {
      const error = new Error(`boom-${testCase.what}`);

      async function capture(): Promise<unknown[]> {
        mockedAxios[testCase.verb].mockRejectedValue(error);
        await expect(testCase.invoke(testCase.tainted)).rejects.toThrow(error);
        expect(spy).toHaveBeenCalledTimes(1);
        return spy.mock.calls[0] as unknown[];
      }

      it('keeps the error object out of the formatting', async () => {
        const args = await capture();
        // The point of the log. Broken code passes `e` straight into the mouth
        // of the directives the tainted id smuggled into argument 0.
        expect(survivesFormatting(args, error)).toBe(true);
      });

      it('puts no caller-controlled directive in argument 0', async () => {
        const args = await capture();
        expect(args[0]).toEqual(expect.any(String));
        expect(args[0] as string).not.toMatch(DIRECTIVE);
      });

      it('passes the interpolated values as arguments of their own', async () => {
        const args = await capture();
        for (const value of testCase.tainted) {
          expect(survivesFormatting(args, value)).toBe(true);
        }
      });

      it('keeps the message greppable', async () => {
        const args = await capture();
        expect(args[0] as string).toContain(testCase.greppable);
      });
    });
  }
});
