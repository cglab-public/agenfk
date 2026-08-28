import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { program } from '../index';
import axios from 'axios';
import * as child_process from 'child_process';

vi.mock('axios');
vi.mock('child_process');
const mockedAxios = vi.mocked(axios, true);
const mockedChildProcess = vi.mocked(child_process, true);

const ITEM_ID = '11111111-2222-3333-4444-555555555555';
const PARENT_ID = '99999999-8888-7777-6666-555544443333';

class ExitError extends Error {
  code?: number;
  constructor(code?: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function mockItem(partial: Record<string, unknown> = {}) {
  mockedAxios.get.mockResolvedValue({
    data: { id: ITEM_ID, type: 'STORY', title: 'Fix the thing', ...partial },
  });
  mockedAxios.put.mockResolvedValue({ data: { id: ITEM_ID } });
}

/** The action must reach git as exactly one argument, no shell. */
function expectCheckout(branch: string) {
  expect(mockedChildProcess.execFileSync).toHaveBeenCalledWith(
    'git',
    ['checkout', '-b', branch],
    { stdio: 'inherit' },
  );
}

describe('branch create', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Commander options (recursively — nested subcommand options, like
    // `branch create`'s --name, are not reset by a fresh parse)
    const resetCommandOptions = (cmd: any) => {
      (cmd.options || []).forEach((opt: any) => {
        cmd.setOptionValue(opt.attributeName(), undefined);
      });
      (cmd.commands || []).forEach((sub: any) => resetCommandOptions(sub));
    };
    resetCommandOptions(program);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new ExitError(code);
      }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('uses --name verbatim for non-BUG items — no auto feature/ prefix (the CGLAB-37 bug)', async () => {
    mockItem({ type: 'STORY' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', 'feat/CGLAB-37_no-auto-branch-prefix',
    ]);

    expectCheckout('feat/CGLAB-37_no-auto-branch-prefix');
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${ITEM_ID}`),
      { branchName: 'feat/CGLAB-37_no-auto-branch-prefix' },
    );
  });

  it('uses --name verbatim for BUG items even when it does not start with fix/', async () => {
    mockItem({ type: 'BUG' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', 'hotfix/CGLAB-37_emergency',
    ]);

    expectCheckout('hotfix/CGLAB-37_emergency');
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${ITEM_ID}`),
      { branchName: 'hotfix/CGLAB-37_emergency' },
    );
  });

  it('still honours an explicit feature/-prefixed --name (no double prefix, no stripping)', async () => {
    mockItem({ type: 'STORY' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', 'feature/legacy-override',
    ]);

    expectCheckout('feature/legacy-override');
  });

  it('does not re-prefix an explicit fix/ --name on a non-BUG item (discriminates from the old strip-then-re-prefix code)', async () => {
    mockItem({ type: 'STORY' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', 'fix/CGLAB-37_strip-check',
    ]);

    expectCheckout('fix/CGLAB-37_strip-check');
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${ITEM_ID}`),
      { branchName: 'fix/CGLAB-37_strip-check' },
    );
  });

  it('does not re-prefix an explicit feature/ --name on a BUG item (discriminates from the old strip-then-re-prefix code)', async () => {
    mockItem({ type: 'BUG' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', 'feature/CGLAB-37_strip-check',
    ]);

    expectCheckout('feature/CGLAB-37_strip-check');
  });

  it('trims surrounding whitespace so the recorded name matches the real git branch', async () => {
    mockItem({ type: 'STORY' });
    await program.parseAsync([
      'node', 'agenfk', 'branch', 'create', ITEM_ID,
      '--name', '   feat/CGLAB-37_trim-check   ',
    ]);

    expectCheckout('feat/CGLAB-37_trim-check');
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${ITEM_ID}`),
      { branchName: 'feat/CGLAB-37_trim-check' },
    );
  });

  it('auto-generates feature/<slug> from the title when --name is omitted (non-BUG)', async () => {
    mockItem({ type: 'STORY', title: 'Fix the thing, now!' });
    await program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID]);

    expectCheckout('feature/fix-the-thing-now');
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.stringContaining(`/items/${ITEM_ID}`),
      { branchName: 'feature/fix-the-thing-now' },
    );
  });

  it('auto-generates fix/<slug> from the title when --name is omitted (BUG)', async () => {
    mockItem({ type: 'BUG', title: 'Fix the thing, now!' });
    await program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID]);

    expectCheckout('fix/fix-the-thing-now');
  });

  it('rejects an empty --name with an explicit error instead of silently auto-generating', async () => {
    mockItem({ type: 'STORY' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID, '--name', '']),
    ).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--name must not be empty or whitespace'));
    expect(mockedChildProcess.execFileSync).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rejects a whitespace-only --name with an explicit error', async () => {
    mockItem({ type: 'STORY' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID, '--name', '   ']),
    ).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--name must not be empty or whitespace'));
    expect(mockedChildProcess.execFileSync).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('refuses child items and never creates a branch or links one', async () => {
    mockItem({ parentId: PARENT_ID });
    await expect(
      program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID]),
    ).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedChildProcess.execFileSync).not.toHaveBeenCalled();
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });

  it('does not link the branch when git checkout -b fails', async () => {
    mockItem({ type: 'STORY' });
    mockedChildProcess.execFileSync.mockImplementation(() => {
      throw new Error('branch already exists');
    });
    await expect(
      program.parseAsync(['node', 'agenfk', 'branch', 'create', ITEM_ID]),
    ).rejects.toThrow(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedAxios.put).not.toHaveBeenCalled();
  });
});
