/**
 * @vitest-environment jsdom
 *
 * Making the sound.
 *
 * The built-in tone is SYNTHESISED rather than shipped as a file, and that is
 * not a size optimisation. An asset has to be fetched, which means it can fail
 * to load, which means the preview button on the settings screen can do nothing
 * with no way for the user to tell whether the sound is broken or the setting
 * is. Two oscillator notes have no such failure mode.
 *
 * The custom sound is the opposite case: it genuinely can be unavailable — the
 * user chose a file and later deleted it — and the rule there is that it falls
 * back to the tone rather than going silent. Silence is indistinguishable from
 * the feature being off, which is the state the user was trying to leave.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { playAttentionSound, __resetAudioContext } from '../attentionSound';

/** The bits of Web Audio this uses, and nothing else. */
const fakeAudioContext = () => {
  const started: number[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    state: 'running',
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createOscillator: vi.fn(() => ({
      type: 'sine',
      frequency: { value: 0, setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn((t: number) => started.push(t)),
      stop: vi.fn(),
      onended: null as null | (() => void),
    })),
    createGain: vi.fn(() => ({
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    })),
  };
  return { ctx, started };
};

// The context is module state now, so each case starts without one.
beforeEach(() => { __resetAudioContext(); });

describe('the built-in tone', () => {
  it('plays without fetching anything', async () => {
    // Nothing to 404, nothing to be blocked by a CSP, nothing that behaves
    // differently in a packaged app than in the dev server.
    const { ctx, started } = fakeAudioContext();
    const played = await playAttentionSound({
      readCustomSound: async () => null,
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: vi.fn(),
    });
    expect(played).toBe(true);
    expect(started.length).toBeGreaterThan(0);
  });

  it('does not throw where there is no Web Audio at all', async () => {
    // jsdom has none, and neither does a browser with autoplay locked down. A
    // throw here would escape into the terminal's activity handler.
    const played = await playAttentionSound({
      readCustomSound: async () => null,
      AudioContext: () => { throw new Error('not supported'); },
      playDataUrl: vi.fn(),
    });
    expect(played).toBe(false);
  });
});

describe('a sound the user chose', () => {
  it('plays that instead of the tone', async () => {
    const playDataUrl = vi.fn(async () => true);
    const { started } = fakeAudioContext();
    const played = await playAttentionSound({
      readCustomSound: async () => ({ dataUrl: 'data:audio/wav;base64,UklGRg==', name: 'ping.wav' }),
      AudioContext: () => { throw new Error('should not be reached'); },
      playDataUrl,
    });
    expect(played).toBe(true);
    expect(playDataUrl).toHaveBeenCalledWith('data:audio/wav;base64,UklGRg==');
    expect(started).toHaveLength(0);
  });

  it('falls back to the tone when the chosen file has gone', async () => {
    // The user picked something in ~/Downloads and emptied the folder. Going
    // silent would look exactly like the setting having turned itself off.
    const { ctx, started } = fakeAudioContext();
    const played = await playAttentionSound({
      readCustomSound: async () => null,
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: vi.fn(),
    });
    expect(played).toBe(true);
    expect(started.length).toBeGreaterThan(0);
  });

  it('falls back to the tone when the browser refuses to play the file', async () => {
    // An .m4a the picker accepted and this build's Chromium will not decode.
    const { ctx, started } = fakeAudioContext();
    const played = await playAttentionSound({
      readCustomSound: async () => ({ dataUrl: 'data:audio/mp4;base64,AAAA', name: 'x.m4a' }),
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: async () => false,
    });
    expect(played).toBe(true);
    expect(started.length).toBeGreaterThan(0);
  });

  it('falls back to the tone when asking for it throws', async () => {
    // An older preload with no sounds channel rejects the invoke.
    const { ctx, started } = fakeAudioContext();
    const played = await playAttentionSound({
      readCustomSound: async () => { throw new Error('no such channel'); },
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: vi.fn(),
    });
    expect(played).toBe(true);
    expect(started.length).toBeGreaterThan(0);
  });
});

/**
 * One context, however many times the sound plays.
 *
 * An adversarial review found a fresh `new AudioContext()` per call. Chromium
 * caps how many a document may hold, so after a handful of presses on the
 * preview button the constructor throws, this module catches it and answers
 * false, and the button goes silently dead until a reload.
 *
 * Silent failure is precisely what this file's header says the synthesised tone
 * exists to avoid - so the leak turned the feature into its own stated enemy,
 * and only after the sixth or seventh press, which is exactly the kind of thing
 * nobody reproduces by hand.
 */
describe('playing it more than once', () => {
  it('makes one context and reuses it', async () => {
    const { ctx } = fakeAudioContext();
    const make = vi.fn(() => ctx as unknown as AudioContext);
    const deps = { readCustomSound: async () => null, AudioContext: make, playDataUrl: vi.fn() };
    for (let i = 0; i < 12; i++) await playAttentionSound(deps);
    expect(make, 'a context was created per call').toHaveBeenCalledTimes(1);
  });

  it('still plays every time, rather than only the first', async () => {
    // The obvious wrong fix: keep the context and stop scheduling notes on it.
    const { ctx, started } = fakeAudioContext();
    const deps = {
      readCustomSound: async () => null,
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: vi.fn(),
    };
    await playAttentionSound(deps);
    const afterFirst = started.length;
    await playAttentionSound(deps);
    expect(started.length).toBeGreaterThan(afterFirst);
  });

  it('replaces a context that has been closed', async () => {
    // A closed context accepts no new nodes, so reusing one would kill every
    // alert from that point on - a worse failure than the leak it replaces.
    const first = fakeAudioContext();
    const second = fakeAudioContext();
    const make = vi.fn()
      .mockReturnValueOnce(first.ctx as unknown as AudioContext)
      .mockReturnValueOnce(second.ctx as unknown as AudioContext);
    const deps = { readCustomSound: async () => null, AudioContext: make, playDataUrl: vi.fn() };
    await playAttentionSound(deps);
    first.ctx.state = 'closed';
    expect(await playAttentionSound(deps)).toBe(true);
    expect(second.started.length).toBeGreaterThan(0);
  });

  it('resumes a context the browser parked', async () => {
    // Created before any user gesture, the autoplay policy suspends it and the
    // notes are scheduled into silence.
    const { ctx } = fakeAudioContext();
    ctx.state = 'suspended';
    await playAttentionSound({
      readCustomSound: async () => null,
      AudioContext: () => ctx as unknown as AudioContext,
      playDataUrl: vi.fn(),
    });
    expect(ctx.resume).toHaveBeenCalled();
  });
});
