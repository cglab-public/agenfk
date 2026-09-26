/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollPageToTop } from '../scroll';

describe('scrollPageToTop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('scrolls the window, for pages outside the app shell', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    scrollPageToTop();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("scrolls the shell's content pane back to the top, since that pane is what scrolls", () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const root = document.createElement('main');
    root.setAttribute('data-scroll-root', '');
    document.body.appendChild(root);
    root.scrollTop = 480;
    scrollPageToTop();
    expect(root.scrollTop).toBe(0);
  });
});
