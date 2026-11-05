/**
 * @vitest-environment node
 *
 * INFRA-425: the wsl.exe calls behind distro listing and agent detection,
 * with the process runner injected so none of them starts wsl.exe.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWslProbe } from '../main/wslProbe';

const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le')]);

type Run = Parameters<typeof createWslProbe>[0]['run'];

/** A runner answering by the wsl.exe arguments it was given. */
const fake = (answers: { list?: Buffer | Error; running?: Buffer | Error; probe?: string | Error }) =>
  vi.fn(async (_file: string, args: readonly string[]) => {
    const pick = args.includes('--running') ? answers.running : args.includes('--list') ? answers.list : answers.probe;
    if (pick instanceof Error || pick === undefined) throw pick ?? new Error('unexpected call');
    return pick;
  }) as unknown as Run & ReturnType<typeof vi.fn>;

const make = (run: Run) => createWslProbe({ run, exe: 'wsl.exe', env: {} });

describe('listing distros', () => {
  it('reads a UTF-16 list', async () => {
    const probe = make(fake({ list: utf16('Ubuntu\nDebian\n') }));
    expect(await probe.listDistros()).toEqual(['Ubuntu', 'Debian']);
  });

  it('reads a 5 second timeout as no distro, and asks again next time', async () => {
    const run = fake({ list: Object.assign(new Error('timed out'), { killed: true }) });
    const probe = make(run);
    expect(await probe.listDistros()).toEqual([]);
    expect(await probe.listDistros()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
    expect((run as any).mock.calls[0][2]).toMatchObject({ timeout: 5000 });
  });

  it('remembers a success for a minute', async () => {
    let now = 0;
    const run = fake({ list: utf16('Ubuntu\n') });
    const probe = createWslProbe({ run, exe: 'wsl.exe', env: {}, now: () => now });
    await probe.listDistros();
    now = 30_000;
    await probe.listDistros();
    expect(run).toHaveBeenCalledTimes(1);
    now = 61_000;
    await probe.listDistros();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('listing running distros', () => {
  it('reads the running list, without starting anything', async () => {
    const run = fake({ running: utf16('Debian\n') });
    expect(await make(run).listRunning()).toEqual(['Debian']);
    expect((run as any).mock.calls[0][1]).toEqual(['--list', '--running', '--quiet']);
  });

  it('reads a failure as none running', async () => {
    expect(await make(fake({ running: new Error('boom') })).listRunning()).toEqual([]);
  });
});

describe('finding agents in WSL', () => {
  const files = ['claude', 'codex'];

  it('probes the only running distro when none is chosen, even if it is not the default', async () => {
    const run = fake({ list: utf16('Ubuntu\nDebian\n'), running: utf16('Debian\n'), probe: 'claude\n' });
    const out = await make(run).agentsIn(files, '');
    expect(out).toEqual({ found: new Set(['claude']), exclusive: false });
    const probeArgs = (run as any).mock.calls.at(-1)[1] as string[];
    expect(probeArgs.slice(0, 2)).toEqual(['--distribution', 'Debian']);
  });

  it('does not wake WSL when nothing is running and no distro is chosen', async () => {
    const run = fake({ list: utf16('Ubuntu\n'), running: utf16('') });
    expect(await make(run).agentsIn(files, '')).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('answers exclusive with nothing found when a chosen distro fails its probe', async () => {
    const run = fake({ list: utf16('Ubuntu\nDebian\n'), probe: new Error('timed out') });
    expect(await make(run).agentsIn(files, 'Debian')).toEqual({ found: new Set(), exclusive: true });
  });

  it('lets an unchosen failed probe fall back to Windows', async () => {
    const run = fake({ list: utf16('Ubuntu\n'), running: utf16('Ubuntu\n'), probe: new Error('timed out') });
    expect(await make(run).agentsIn(files, '')).toBeNull();
  });

  it('reads no distro at all as no answer', async () => {
    expect(await make(fake({ list: new Error('no wsl') })).agentsIn(files, 'Debian')).toBeNull();
  });

  it('probes a chosen distro exclusively, without asking what is running', async () => {
    const run = fake({ list: utf16('Ubuntu\nDebian\n'), probe: 'codex\nnoise\n' });
    expect(await make(run).agentsIn(files, 'Debian')).toEqual({ found: new Set(['codex']), exclusive: true });
  });
});
