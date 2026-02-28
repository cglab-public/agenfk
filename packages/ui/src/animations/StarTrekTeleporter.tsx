import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const PARTICLE_COUNT = 40;
const DURATION = 1200;

interface Particle {
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

function generateParticles(width: number, height: number): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: 2 + Math.random() * 4,
    delay: Math.random() * 0.4,
    duration: 0.4 + Math.random() * 0.6,
  }));
}

const StarTrekTeleporter: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [particles, setParticles] = useState<Particle[]>([]);
  const isEnter = trigger === 'enter';

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setParticles(generateParticles(width, height));
    }
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div ref={containerRef} style={{ position: 'relative', overflow: 'visible' }}>
      {/* Card content with materialize/dematerialize */}
      <motion.div
        initial={isEnter ? { opacity: 0, scaleY: 0.01, filter: 'brightness(3) blur(4px)' } : { opacity: 1, scaleY: 1, filter: 'brightness(1) blur(0px)' }}
        animate={isEnter ? { opacity: 1, scaleY: 1, filter: 'brightness(1) blur(0px)' } : { opacity: 0, scaleY: 0.01, filter: 'brightness(3) blur(4px)' }}
        transition={{ duration: DURATION / 1000, ease: [0.25, 0.1, 0.25, 1] }}
        style={{ transformOrigin: 'center center' }}
      >
        {children}
      </motion.div>

      {/* Sparkle particles */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
        {particles.map((p, i) => (
          <motion.div
            key={i}
            initial={isEnter
              ? { opacity: 1, scale: 1.5, x: p.x, y: p.y }
              : { opacity: 0, scale: 0, x: p.x, y: p.y }
            }
            animate={isEnter
              ? { opacity: 0, scale: 0, y: p.y + (Math.random() - 0.5) * 30 }
              : { opacity: [0, 1, 1, 0], scale: [0, 1.5, 1.5, 0], y: p.y + (Math.random() - 0.5) * 40 }
            }
            transition={{
              duration: p.duration,
              delay: p.delay,
              ease: 'easeOut',
            }}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              width: p.size,
              height: p.size,
              borderRadius: '50%',
              background: `radial-gradient(circle, rgba(180,220,255,1) 0%, rgba(100,160,255,0.8) 40%, transparent 70%)`,
              boxShadow: `0 0 ${p.size * 2}px rgba(150,200,255,0.8)`,
            }}
          />
        ))}
      </div>
    </div>
  );
};

registerAnimation({
  name: 'star-trek-teleporter',
  Wrapper: StarTrekTeleporter,
});

export default StarTrekTeleporter;
