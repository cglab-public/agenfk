/**
 * The screen the app opens on (004bd193).
 *
 * The brand book draws the product's name and mark, and sanctions the
 * animation in exactly one place: "animate only on the first load; after that
 * the logo is still." This is that place - it is shown once, on startup, and
 * never again in the life of the window. A permanent loop here would be the
 * rule broken at the one moment it is allowed.
 *
 * NOT A LOADING BAR. It does not read a query, because a bar that is really a
 * timer is a lie about what is happening; it is a curtain over the first
 * paint, and it lets go on its own. A phase that waits for data is a different
 * component and would need a different reason to exist.
 */
import React from 'react';
import { clsx } from 'clsx';
import { AgenfkFlag } from './AgenfkFlag';
import { AgenfkWordmark } from './AgenfkWordmark';

export interface SplashScreenProps {
  /** How long the mark holds before it starts to leave. */
  readonly holdMs?: number;
  /** Called once the curtain is gone, so a caller can stop mounting it. */
  readonly onDone?: () => void;
}

/** The fade itself. Long enough to read as leaving, short enough not to wait. */
const FADE_MS = 350;

export function SplashScreen({ holdMs = 900, onDone }: SplashScreenProps): React.ReactElement | null {
  const [leaving, setLeaving] = React.useState(false);
  const [gone, setGone] = React.useState(false);

  React.useEffect(() => {
    const leave = setTimeout(() => setLeaving(true), holdMs);
    // `gone`, not `leaving`: unmounting at the START of the fade would cut it
    // off, which is the one frame the whole component exists for.
    const finish = setTimeout(() => { setGone(true); onDone?.(); }, holdMs + FADE_MS);
    return () => { clearTimeout(leave); clearTimeout(finish); };
  }, [holdMs, onDone]);

  if (gone) return null;

  return (
    <div
      data-testid="splash-screen"
      aria-hidden="true"
      className={clsx(
        'fixed inset-0 z-[100] flex items-center justify-center bg-canvas transition-opacity',
        leaving ? 'opacity-0' : 'opacity-100',
      )}
      // The duration is a style, not a utility, because Tailwind has no
      // `duration-350` and rounding it to 300 would drift from FADE_MS.
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      {/* The lockup, like WelcomeScreen: the flag with the name beside it.
          `animate-pulse` on the flag alone - the name is already legible and
          pulsing it too would read as an alarm. */}
      <div className="flex items-center gap-4">
        <AgenfkFlag size={56} label="AgEnFK" className="animate-pulse" />
        <AgenfkWordmark size={30} />
      </div>
    </div>
  );
}
