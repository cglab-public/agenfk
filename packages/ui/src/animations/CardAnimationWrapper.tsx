import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, usePresence } from 'framer-motion';
import { getRandomAnimation } from './registry';
import { AnimationTrigger, EasterEggAnimation } from './types';

// Module-level maps to persist state across mount/unmount cycles.
const prevStatuses = new Map<string, string>();
const chosenAnimations = new Map<string, EasterEggAnimation>();

/** Guarantee an animation is stored for this item. */
function ensureAnimation(itemId: string): EasterEggAnimation | null {
  let anim = chosenAnimations.get(itemId) ?? null;
  if (!anim) {
    anim = getRandomAnimation();
    if (anim) chosenAnimations.set(itemId, anim);
  }
  return anim;
}

interface CardAnimationWrapperProps {
  enabled: boolean;
  itemId: string;
  status: string;
  children: React.ReactNode;
}

export const CardAnimationWrapper: React.FC<CardAnimationWrapperProps> = ({
  enabled,
  itemId,
  status,
  children,
}) => {
  const [isPresent, safeToRemove] = usePresence();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeAnimation, setActiveAnimation] = useState<{
    animation: EasterEggAnimation;
    trigger: AnimationTrigger;
  } | null>(null);

  // ── Refs for callback stability ────────────────────────────────────
  // safeToRemove / isPresent may change reference every render.
  // Storing them in refs keeps handleComplete stable so animation
  // components' useEffect([onComplete]) timers don't keep resetting.
  const isPresentRef = useRef(isPresent);
  const safeToRemoveRef = useRef(safeToRemove);
  isPresentRef.current = isPresent;
  safeToRemoveRef.current = safeToRemove;

  // ── Initialise on first mount ──────────────────────────────────────
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      // Only seed prevStatuses if this item has never been seen.
      // An existing entry means the old wrapper already recorded it.
      if (!prevStatuses.has(itemId)) {
        prevStatuses.set(itemId, status);
      }
      if (enabled) ensureAnimation(itemId);
    }
  }, []);

  // ── EXIT (card leaving old column) ─────────────────────────────────
  useEffect(() => {
    if (!isPresent) {
      if (enabled) {
        const anim = ensureAnimation(itemId);
        if (anim) {
          setActiveAnimation({ animation: anim, trigger: 'exit' });
          return; // safeToRemove called in handleComplete
        }
      }
      safeToRemove?.();
    }
  }, [isPresent]);

  // ── ENTER (card arriving in new column) ────────────────────────────
  useEffect(() => {
    // Skip the very first mount — handled by the init effect above.
    if (!initialized.current) return;

    const prev = prevStatuses.get(itemId);
    prevStatuses.set(itemId, status);

    if (!enabled || !prev || prev === status) return;

    const anim = ensureAnimation(itemId);
    if (anim) {
      setActiveAnimation({ animation: anim, trigger: 'enter' });
    }
  }, [status, enabled, itemId]);

  // ── Completion handler (stable reference) ──────────────────────────
  const handleComplete = useCallback(() => {
    if (!isPresentRef.current) {
      safeToRemoveRef.current?.();
    } else {
      // Rotate to a new random animation for the next transition.
      const next = getRandomAnimation();
      if (next) chosenAnimations.set(itemId, next);
    }
    setActiveAnimation(null);
  }, [itemId]);

  // ── Render ─────────────────────────────────────────────────────────
  if (!activeAnimation) {
    return (
      <motion.div ref={containerRef} data-animation-card={itemId} layout={false}>
        {children}
      </motion.div>
    );
  }

  const { animation, trigger } = activeAnimation;
  const Wrapper = animation.Wrapper;

  return (
    <motion.div ref={containerRef} data-animation-card={itemId} layout={false}>
      <Wrapper
        trigger={trigger}
        onComplete={handleComplete}
        cardRect={containerRef.current?.getBoundingClientRect() ?? null}
      >
        {children}
      </Wrapper>
    </motion.div>
  );
};
