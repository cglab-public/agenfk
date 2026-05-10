import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollPageToTop } from '../scroll';

describe('scrollPageToTop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls window.scrollTo(0, 0)', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo });
    scrollPageToTop();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
