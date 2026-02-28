import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const DURATION = 1000;
const SMOKE_COUNT = 8;

interface SmokeCloud {
  x: number;
  y: number;
  size: number;
  delay: number;
}

function generateSmokeClouds(width: number, height: number): SmokeCloud[] {
  const cx = width / 2;
  const cy = height / 2;
  return Array.from({ length: SMOKE_COUNT }, (_, i) => {
    const angle = (i / SMOKE_COUNT) * Math.PI * 2;
    const dist = 20 + Math.random() * 30;
    return {
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      size: 40 + Math.random() * 40,
      delay: Math.random() * 0.15,
    };
  });
}

const NarutoNinjaBomb: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clouds, setClouds] = useState<SmokeCloud[]>([]);
  const isEnter = trigger === 'enter';

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setClouds(generateSmokeClouds(width, height));
    }
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div ref={containerRef} style={{ position: 'relative', overflow: 'visible' }}>
      {/* Card content — hidden behind smoke */}
      <motion.div
        initial={isEnter ? { opacity: 0, scale: 0.3 } : { opacity: 1, scale: 1 }}
        animate={isEnter ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.3 }}
        transition={{ duration: DURATION / 1000 * 0.6, delay: isEnter ? 0.3 : 0, ease: 'easeOut' }}
      >
        {children}
      </motion.div>

      {/* Smoke poof */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
        {clouds.map((cloud, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, scale: 0, x: cloud.x - cloud.size / 2, y: cloud.y - cloud.size / 2 }}
            animate={{
              opacity: [0, 0.85, 0.85, 0],
              scale: [0, 1.2, 1.4, 1.8],
            }}
            transition={{
              duration: DURATION / 1000 * 0.8,
              delay: cloud.delay,
              ease: 'easeOut',
            }}
            style={{
              position: 'absolute',
              width: cloud.size,
              height: cloud.size,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(220,220,220,0.9) 0%, rgba(180,180,180,0.5) 50%, transparent 70%)',
              filter: 'blur(6px)',
            }}
          />
        ))}
      </div>
    </div>
  );
};

registerAnimation({
  name: 'naruto-ninja-bomb',
  Wrapper: NarutoNinjaBomb,
});

export default NarutoNinjaBomb;
