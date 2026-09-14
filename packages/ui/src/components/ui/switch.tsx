/**
 * Switch — shadcn's component, on this project's palette.
 *
 * Two hand-rolled switches had appeared (the terminal dialog and the settings
 * screen) and they had already drifted: different track colours, different
 * thumb offsets, and only one of them carried the reduced-motion escape. That
 * is the ordinary way a design system rots, so this is the extraction the
 * REFACTOR step asks for — one obvious abstraction, not a guessed one.
 *
 * It is shadcn's shape, which means Radix underneath and the component source
 * living in this repo rather than behind a version bump. What that buys, and
 * the reason it is worth a dependency: the accessible behaviour of a switch is
 * more than `role="switch"`. Radix handles Space and Enter, the disabled
 * semantics, the form-association case, and keeps `aria-checked` in step with
 * `data-state`. Both hand-rolled versions were `<button>`s that happened to
 * look right and answered the keyboard only by accident of being buttons.
 *
 * The colours are this project's tokens, not shadcn's defaults — `bg-primary`
 * and `bg-input` do not exist here, and pasting them would have produced an
 * invisible switch on both themes.
 */
import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { clsx } from 'clsx';

export type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={clsx(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
      'border border-transparent transition-colors motion-reduce:transition-none',
      // No ring-offset: Tailwind's offset colour is white everywhere in this
      // bundle, which draws a white band between the track and the ring on the
      // dark theme.
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      // Not merely dimmed: a switch that looks pressable and does nothing is
      // worse than one that reads as unavailable.
      'disabled:cursor-not-allowed disabled:opacity-60',
      // bg-brand, not a palette literal. Both switches this replaced used the
      // brand teal; emerald-500 put the one control that says "on" out of step
      // with every other affordance in the app — while the docblock above
      // claimed the colours came from tokens.
      'data-[state=checked]:bg-brand',
      // The off state has to be VISIBLE. bg-canvas equals the card it sits on
      // in both themes, and border-soft against it is about 1.1:1 — an off
      // switch read as blank space, so the user could not see there was a
      // control at all.
      'data-[state=unchecked]:border-ink-tertiary/40 data-[state=unchecked]:bg-ink-tertiary/15',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={clsx(
        'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm ring-0',
        // The escape is on the thumb because the thumb is the part that moves.
        // Without it the toggle still works; it just stops sliding.
        'transition-transform motion-reduce:transition-none',
        'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5',
      )}
    />
  </SwitchPrimitive.Root>
));

Switch.displayName = 'Switch';
