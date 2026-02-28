import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const DURATION = 1500;
const DUST_COUNT = 120;

interface DustParticle {
  x: number;
  y: number;
  size: number;
  driftX: number;
  driftY: number;
  delay: number;
  opacity: number;
}

function generateDust(width: number, height: number): DustParticle[] {
  return Array.from({ length: DUST_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: 1 + Math.random() * 2.5,
    driftX: (Math.random() - 0.3) * 100,
    driftY: -(8 + Math.random() * 45),
    delay: Math.random() * 0.5,
    opacity: 0.6 + Math.random() * 0.4,
  }));
}

const ThanosSnap: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dust, setDust] = useState<DustParticle[]>([]);
  const isEnter = trigger === 'enter';

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDust(generateDust(width, height));
    }
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div ref={containerRef} style={{ position: 'relative', overflow: 'visible' }}>
      {/* Card content — disintegrates / reintegrates */}
      <motion.div
        initial={isEnter
          ? { opacity: 0, filter: 'blur(3px)' }
          : { opacity: 1, filter: 'blur(0px)' }
        }
        animate={isEnter
          ? { opacity: 1, filter: 'blur(0px)' }
          : { opacity: [1, 1, 0], filter: ['blur(0px)', 'blur(1px)', 'blur(4px)'] }
        }
        transition={{
          duration: DURATION / 1000 * 0.7,
          delay: isEnter ? 0.4 : 0.2,
          ease: 'easeIn',
        }}
      >
        {children}
      </motion.div>

      {/* Black dust particles */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
        {dust.map((p, i) => (
          <motion.div
            key={i}
            initial={isEnter
              ? { opacity: p.opacity, x: p.x + p.driftX, y: p.y + p.driftY, scale: 1 }
              : { opacity: 0, x: p.x, y: p.y, scale: 0 }
            }
            animate={isEnter
              ? { opacity: 0, x: p.x, y: p.y, scale: 0 }
              : { opacity: [0, p.opacity, p.opacity, 0], x: p.x + p.driftX, y: p.y + p.driftY, scale: [0, 1, 1, 0.3] }
            }
            transition={{
              duration: 0.5 + Math.random() * 0.5,
              delay: p.delay,
              ease: 'easeOut',
            }}
            style={{
              position: 'absolute',
              width: p.size,
              height: p.size,
              borderRadius: Math.random() > 0.5 ? '50%' : '1px',
              background: `rgba(0,0,0,${0.7 + Math.random() * 0.3})`,
            }}
          />
        ))}
      </div>
    </div>
  );
};

registerAnimation({
  name: 'thanos-snap',
  Wrapper: ThanosSnap,
});

export default ThanosSnap;
