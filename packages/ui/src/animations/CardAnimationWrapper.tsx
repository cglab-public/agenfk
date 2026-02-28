import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getRandomAnimation } from './registry';
import { AnimationTrigger, EasterEggAnimation } from './types';

interface CardAnimationWrapperProps {
  enabled: boolean;
  itemId: string;
  status: string;
  children: React.ReactNode;
}

/**
 * Wraps a KanbanCard and plays a random easter egg animation
 * when the card's status changes (column transition).
 */
export const CardAnimationWrapper: React.FC<CardAnimationWrapperProps> = ({
  enabled,
  itemId,
  status,
  children,
}) => {
  const prevStatus = useRef(status);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeAnimation, setActiveAnimation] = useState<{
    animation: EasterEggAnimation;
    trigger: AnimationTrigger;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (status !== prevStatus.current) {
      prevStatus.current = status;
      const animation = getRandomAnimation();
      if (animation) {
        // Play enter animation in the new column
        setActiveAnimation({ animation, trigger: 'enter' });
      }
    }
  }, [status, enabled]);

  const handleAnimationComplete = useCallback(() => {
    setActiveAnimation(null);
  }, []);

  if (!activeAnimation) {
    return <div ref={containerRef} data-animation-card={itemId}>{children}</div>;
  }

  const { animation, trigger } = activeAnimation;
  const Wrapper = animation.Wrapper;

  return (
    <div ref={containerRef} data-animation-card={itemId}>
      <Wrapper
        trigger={trigger}
        onComplete={handleAnimationComplete}
        cardRect={containerRef.current?.getBoundingClientRect() ?? null}
      >
        {children}
      </Wrapper>
    </div>
  );
};
