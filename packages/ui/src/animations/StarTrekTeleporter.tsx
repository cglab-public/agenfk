import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const STRAND_COUNT = 14;
const SPARKLES_PER_STRAND = 6;
const DURATION = 1800;

interface Strand {
  x: number;
  width: number;
  delay: number;
}

interface Sparkle {
  strandX: number;
  y: number;
  size: number;
  delay: number;
  drift: number;
}

function generateStrands(): Strand[] {
  return Array.from({ length: STRAND_COUNT }, (_, i) => ({
    x: 4 + (i / (STRAND_COUNT - 1)) * 92,
    width: 1.5 + Math.random() * 1.5,
    delay: Math.random() * 0.25,
  }));
}

function generateSparkles(): Sparkle[] {
  return Array.from({ length: STRAND_COUNT * SPARKLES_PER_STRAND }, () => ({
    strandX: 4 + Math.random() * 92,
    y: Math.random() * 100,
    size: 1.5 + Math.random() * 3,
    delay: Math.random() * 0.6,
    drift: (Math.random() - 0.5) * 6,
  }));
}

const StarTrekTeleporter: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const [strands] = useState(generateStrands);
  const [sparkles] = useState(generateSparkles);
  const isEnter = trigger === 'enter';
  const totalSec = DURATION / 1000;

  useEffect(() => {
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete]);

  // Enter:  sparkles shimmer in → card materialises → sparkles fade
  // Exit:   sparkles shimmer in → card dissolves through sparkles → sparkles fade
  return (
    <div style={{ position: 'relative', overflow: 'visible' }}>
      {/* Card content */}
      <motion.div
        initial={isEnter
          ? { opacity: 0, filter: 'brightness(2.5) saturate(0.3) blur(3px)' }
          : { opacity: 1, filter: 'brightness(1) saturate(1) blur(0px)' }
        }
        animate={isEnter
          ? {
              opacity:  [0, 0, 0.4, 1],
              filter: [
                'brightness(2.5) saturate(0.3) blur(3px)',
                'brightness(2) saturate(0.3) blur(3px)',
                'brightness(1.6) saturate(0.6) blur(1px)',
                'brightness(1) saturate(1) blur(0px)',
              ],
            }
          : {
              opacity:  [1, 1, 0.4, 0],
              filter: [
                'brightness(1) saturate(1) blur(0px)',
                'brightness(1.4) saturate(0.7) blur(1px)',
                'brightness(2) saturate(0.3) blur(3px)',
                'brightness(2.5) saturate(0.2) blur(5px)',
              ],
            }
        }
        transition={{
          duration: totalSec * 0.7,
          delay: isEnter ? totalSec * 0.3 : totalSec * 0.2,
          ease: [0.25, 0.1, 0.25, 1],
          times: [0, 0.15, 0.55, 1],
        }}
      >
        {children}
      </motion.div>

      {/* Vertical shimmering strands */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }}>
        {strands.map((s, i) => (
          <motion.div
            key={`strand-${i}`}
            initial={isEnter
              ? { opacity: 0, scaleY: 0.3 }
              : { opacity: 0, scaleY: 0.3 }
            }
            animate={isEnter
              ? { opacity: [0, 0.9, 0.9, 0.7, 0], scaleY: [0.3, 1, 1, 1, 0.3] }
              : { opacity: [0, 0.9, 0.9, 0.7, 0], scaleY: [0.3, 1, 1, 1, 0.3] }
            }
            transition={{
              duration: totalSec * 0.9,
              delay: s.delay,
              ease: 'easeInOut',
              times: [0, 0.15, 0.45, 0.8, 1],
            }}
            style={{
              position: 'absolute',
              left: `${s.x}%`,
              top: '-4%',
              width: s.width,
              height: '108%',
              transformOrigin: 'center center',
              background: `linear-gradient(180deg,
                transparent 0%,
                rgba(180,210,255,0.5) 10%,
                rgba(200,225,255,0.8) 25%,
                rgba(220,235,255,0.9) 50%,
                rgba(200,225,255,0.8) 75%,
                rgba(180,210,255,0.5) 90%,
                transparent 100%)`,
              boxShadow: `0 0 ${4 + s.width * 2}px rgba(170,200,255,0.6)`,
              borderRadius: '1px',
            }}
          />
        ))}

        {/* Sparkles shimmering along the strands */}
        {sparkles.map((sp, i) => (
          <motion.div
            key={`sparkle-${i}`}
            initial={{ opacity: 0, scale: 0 }}
            animate={{
              opacity: [0, 1, 1, 0.8, 0],
              scale: [0, 1.2, 0.6, 1.4, 0],
              x: [0, sp.drift, -sp.drift, sp.drift * 0.5, 0],
              y: [0, -3, 3, -2, 0],
            }}
            transition={{
              duration: 0.4 + Math.random() * 0.4,
              delay: sp.delay + (isEnter ? 0 : 0.05),
              ease: 'easeInOut',
              repeat: 2,
              repeatType: 'mirror',
            }}
            style={{
              position: 'absolute',
              left: `${sp.strandX}%`,
              top: `${sp.y}%`,
              width: sp.size,
              height: sp.size,
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(200,225,255,0.9) 40%, transparent 70%)',
              boxShadow: `0 0 ${sp.size * 3}px rgba(180,210,255,0.9), 0 0 ${sp.size * 6}px rgba(150,190,255,0.4)`,
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
