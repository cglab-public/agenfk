/**
 * Making the sound.
 *
 * The built-in cue is SYNTHESISED rather than shipped as an asset, and that is
 * not a size optimisation. A file has to be fetched, which means it can fail to
 * load, which means the preview button on the settings screen can silently do
 * nothing — leaving the user unable to tell whether the sound is broken or the
 * setting is. Two oscillator notes have no such failure mode and behave the
 * same in the dev server and in a packaged app.
 *
 * The custom sound is the opposite case: it genuinely can be unavailable, since
 * the user chose a file and may later have deleted it. The rule there is that
 * every failure falls back to the tone rather than going quiet. Silence is
 * indistinguishable from the feature being off, which is the state the user was
 * trying to leave.
 */

import { readSoundFromBridge } from './components/agentBridge';

/** Everything this touches, injected so the rules can be tested in jsdom. */
export interface SoundDeps {
  /** The chosen file's bytes, from the desktop bridge. Null for the built-in. */
  readCustomSound(): Promise<{ dataUrl: string; name: string } | null>;
  AudioContext(): AudioContext;
  /** Plays a data URL. Resolves false when the browser will not decode it. */
  playDataUrl(dataUrl: string): Promise<boolean>;
}

/** Two notes, a fifth apart, short. Long enough to notice, short enough to forgive. */
const NOTES: ReadonlyArray<{ hz: number; at: number; for: number }> = [
  { hz: 660, at: 0, for: 0.12 },
  { hz: 990, at: 0.13, for: 0.18 },
];

function playTone(ctx: AudioContext): void {
  const now = ctx.currentTime;
  for (const note of NOTES) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.hz, now + note.at);
    // Ramped rather than switched. A gain that jumps to zero clicks, and a
    // click is the part people describe as "the notification sounds broken".
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(0.18, now + note.at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.for);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.for + 0.02);
  }
}

/** The real dependencies, for the app. */
export const browserSoundDeps = (
  /**
   * Defaulted, because both real callers pass the same thing.
   *
   * It stays a PARAMETER so a test can hand in its own without reaching for a
   * module mock; it stops being an argument every caller has to remember,
   * which is a second chance for one of them to pass something else.
   */
  readCustomSound: () => Promise<{ dataUrl: string; name: string } | null> = readSoundFromBridge,
): SoundDeps => ({
  readCustomSound,
  AudioContext: () => new (window.AudioContext
    ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(),
  playDataUrl: async dataUrl => {
    try {
      const audio = new Audio(dataUrl);
      await audio.play();
      return true;
    } catch {
      // An .m4a this build's Chromium will not decode, or an autoplay policy
      // that has not seen a user gesture yet. Either way, not a reason to be
      // silent — the caller falls back to the tone.
      return false;
    }
  },
});

/**
 * Play whichever sound applies. Answers whether anything was heard.
 *
 * Never throws: this is reached from the same render path that draws the
 * sessions rail, and an exception here would cost the user their agent-state
 * display over a beep.
 */
export async function playAttentionSound(deps: SoundDeps): Promise<boolean> {
  // `.catch`, not a try/assign. The assignment in the catch branch was dead —
  // `custom` was already null — which eslint reads as a sign the two branches
  // are really one expression, and it is right.
  const custom = await deps.readCustomSound().catch(() => null);
  if (custom) {
    try {
      if (await deps.playDataUrl(custom.dataUrl)) return true;
    } catch {
      // Fall through to the tone.
    }
  }
  try {
    playTone(deps.AudioContext());
    return true;
  } catch {
    // No Web Audio at all: jsdom, or a browser that has locked it down.
    return false;
  }
}
