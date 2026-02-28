import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const DURATION = 1300;

const DragonBallZPowerUp: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const isEnter = trigger === 'enter';

  useEffect(() => {
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div style={{ position: 'relative', overflow: 'visible' }}>
      {/* Energy aura glow */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{
          opacity: [0, 0.8, 1, 0.8, 0],
          scale: [1, 1.08, 1.12, 1.08, 1],
        }}
        transition={{ duration: DURATION / 1000 * 0.7, ease: 'easeInOut' }}
        style={{
          position: 'absolute',
          inset: -8,
          borderRadius: 16,
          background: 'transparent',
          boxShadow: '0 0 20px rgba(255,200,0,0.6), 0 0 40px rgba(255,160,0,0.4), 0 0 60px rgba(255,120,0,0.2), inset 0 0 20px rgba(255,200,0,0.3)',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* Screen shake + card content */}
      <motion.div
        initial={isEnter
          ? { opacity: 0, scale: 0.5 }
          : { opacity: 1, scale: 1 }
        }
        animate={isEnter
          ? {
              opacity: [0, 0.3, 1, 1],
              scale: [0.5, 0.8, 1.05, 1],
              x: [0, -3, 3, -2, 2, -1, 1, 0],
              y: [0, 2, -2, 1, -1, 0],
            }
          : {
              opacity: [1, 1, 1, 0],
              scale: [1, 1.05, 1.1, 0.3],
              x: [0, -4, 4, -3, 3, -2, 2, 0],
              y: [0, 3, -3, 2, -2, 0],
            }
        }
        transition={{
          duration: DURATION / 1000,
          ease: 'easeInOut',
        }}
        style={{ position: 'relative', zIndex: 2 }}
      >
        {children}
      </motion.div>

      {/* Afterimage on exit */}
      {!isEnter && (
        <motion.div
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 1.15, x: 10, y: -5 }}
          transition={{ duration: 0.5, delay: 0.3, ease: 'easeOut' }}
          style={{
            position: 'absolute',
            inset: 0,
            filter: 'blur(3px) brightness(1.5) hue-rotate(30deg)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          {children}
        </motion.div>
      )}
    </div>
  );
};

registerAnimation({
  name: 'dragon-ball-z-power-up',
  Wrapper: DragonBallZPowerUp,
});

export default DragonBallZPowerUp;
