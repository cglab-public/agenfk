import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The content-box width of an element, in whole CSS pixels, kept current
 * through a ResizeObserver. A chart draws in these pixels (its viewBox as wide
 * as its box) so nothing stretches it: a viewBox scaled to fit with
 * preserveAspectRatio="none" scales x and y differently and squashes text.
 *
 * `fallback` stands in until the first measurement, while the element is
 * hidden (a width of 0), and wherever ResizeObserver does not exist.
 * Returns a callback ref for the element and the width.
 */
export function useElementWidth<T extends Element>(fallback: number): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}
