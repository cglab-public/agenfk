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
import { describe, it, expect, vi } from 'vitest';
import { playAttentionSound } from '../attentionSound';

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
