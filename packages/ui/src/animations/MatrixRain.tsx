import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { AnimationWrapperProps } from './types';
import { registerAnimation } from './registry';

const DURATION = 1400;
const COLUMN_COUNT = 28;

const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';

interface MatrixColumn {
  x: number;
  chars: string[];
  speed: number;
  delay: number;
}

function generateColumns(width: number, height: number): MatrixColumn[] {
  const colWidth = width / COLUMN_COUNT;
  return Array.from({ length: COLUMN_COUNT }, (_, i) => {
    const charCount = Math.floor(height / 14) + 2;
    return {
      x: i * colWidth + colWidth / 2,
      chars: Array.from({ length: charCount }, () =>
        MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]
      ),
      speed: 0.6 + Math.random() * 0.4,
      delay: Math.random() * 0.3,
    };
  });
}

const MatrixRain: React.FC<AnimationWrapperProps> = ({ trigger, onComplete, children }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<MatrixColumn[]>([]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const isEnter = trigger === 'enter';

  const init = useCallback(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height });
      setColumns(generateColumns(width, height));
    }
  }, []);

  useEffect(() => {
    init();
    const timer = setTimeout(onComplete, DURATION);
    return () => clearTimeout(timer);
  }, [onComplete, init]);

  return (
    <div ref={containerRef} style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Card content */}
      <motion.div
        initial={isEnter ? { opacity: 0 } : { opacity: 1 }}
        animate={isEnter ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: DURATION / 1000 * 0.6, delay: isEnter ? 0.5 : 0, ease: 'easeInOut' }}
      >
        {children}
      </motion.div>

      {/* Matrix rain overlay */}
      <div style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        borderRadius: 'inherit',
      }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: DURATION / 1000, ease: 'easeInOut' }}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            borderRadius: 'inherit',
          }}
        />
        {columns.map((col, ci) => (
          <div key={ci} style={{ position: 'absolute', left: col.x, top: 0 }}>
            {col.chars.map((char, ri) => (
              <motion.div
                key={ri}
                initial={{ opacity: 0, y: -20 }}
                animate={{
                  opacity: [0, ri === 0 ? 1 : 0.7, ri === 0 ? 1 : 0.5, 0],
                  y: [-(ri * 14), ri * 14],
                }}
                transition={{
                  duration: col.speed,
                  delay: col.delay + ri * 0.04,
                  ease: 'linear',
                }}
                style={{
                  position: 'absolute',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  lineHeight: '14px',
                  color: ri === 0 ? '#fff' : '#00ff41',
                  textShadow: ri === 0 ? '0 0 10px #fff' : '0 0 8px #00ff41',
                  userSelect: 'none',
                }}
              >
                {char}
              </motion.div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

registerAnimation({
  name: 'matrix-rain',
  Wrapper: MatrixRain,
});

export default MatrixRain;
