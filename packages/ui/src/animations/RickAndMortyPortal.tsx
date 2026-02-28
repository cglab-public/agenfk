import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const DURATION = 1400;

const portalKeyframes = `
@keyframes portalSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;

const RickAndMortyPortal: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const isEnter = trigger === 'enter';

  useEffect(() => {
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div style={{ position: 'relative', overflow: 'visible' }}>
      <style>{portalKeyframes}</style>

      {/* Portal vortex */}
      <motion.div
        initial={{ opacity: 0, scale: 0 }}
        animate={{
          opacity: [0, 1, 1, 1, 0],
          scale: [0, 0.5, 1.2, 1.2, 0],
        }}
        transition={{
          duration: DURATION / 1000,
          ease: [0.25, 0.1, 0.25, 1],
        }}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 200,
          height: 200,
          marginTop: -100,
          marginLeft: -100,
          borderRadius: '50%',
          background: 'conic-gradient(from 0deg, #00ff88, #00cc66, #00ffaa, #44ffbb, #00ff88)',
          animation: 'portalSpin 0.8s linear infinite',
          filter: 'blur(8px)',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* Inner portal glow */}
      <motion.div
        initial={{ opacity: 0, scale: 0 }}
        animate={{
          opacity: [0, 0.9, 0.9, 0.9, 0],
          scale: [0, 0.3, 0.8, 0.8, 0],
        }}
        transition={{
          duration: DURATION / 1000,
          ease: [0.25, 0.1, 0.25, 1],
        }}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 120,
          height: 120,
          marginTop: -60,
          marginLeft: -60,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0,255,136,0.9) 0%, rgba(0,200,100,0.6) 40%, transparent 70%)',
          boxShadow: '0 0 40px rgba(0,255,136,0.5), 0 0 80px rgba(0,255,136,0.3)',
          pointerEvents: 'none',
          zIndex: 2,
        }}
      />

      {/* Card content — sucked in / spat out */}
      <motion.div
        initial={isEnter
          ? { opacity: 0, scale: 0, rotate: -180 }
          : { opacity: 1, scale: 1, rotate: 0 }
        }
        animate={isEnter
          ? { opacity: [0, 0, 1, 1], scale: [0, 0.1, 0.8, 1], rotate: [180, 90, 10, 0] }
          : { opacity: [1, 1, 0.5, 0], scale: [1, 0.8, 0.2, 0], rotate: [0, -30, -120, -180] }
        }
        transition={{
          duration: DURATION / 1000 * 0.8,
          delay: isEnter ? 0.25 : 0,
          ease: [0.4, 0, 0.2, 1],
        }}
        style={{ position: 'relative', zIndex: 3, transformOrigin: 'center center' }}
      >
        {children}
      </motion.div>
    </div>
  );
};

registerAnimation({
  name: 'rick-and-morty-portal',
  Wrapper: RickAndMortyPortal,
});

export default RickAndMortyPortal;
