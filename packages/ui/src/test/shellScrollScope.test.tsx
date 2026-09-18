/**
 * The no-scroll rule belongs to the window, not to the page (CGLAB-189).
 *
 * The first version of this fix was a global `html, body { overflow: hidden }`
 * and it broke the browser badly. Measured in real Chromium against the built
 * bundle: at 1440x900, 386px of the board sat below the fold with no scrollbar
 * and no way to reach it; at 600x800 it was 5174px, four of five columns
 * unreachable. The browser branch is `min-h-screen` with AUTO height and was
 * designed around the document scrolling — its board header is `sticky top-0`,
 * which means nothing unless it does.
 *
 * THE SCOPE IS THE WHOLE FIX, so the scope is what these tests pin. They do not
 * try to observe overflow: jsdom has no layout engine and anything claiming to
 * measure a scrollbar here would be theatre. What they can observe is which
 * shell stamped the document, which is the single decision that went wrong.
 *
 * Found by an adversarial review, not by this suite, and that is the other
 * lesson: the fix was verified in the window it repaired and never in the one
 * it could break.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import App from '../App';

vi.mock('../components/KanbanBoard', () => ({ KanbanBoard: () => <div>board</div> }));
vi.mock('../components/AppShell', () => ({ AppShell: ({ children }: any) => <div>{children}</div> }));
vi.mock('../SocketContext', () => ({ SocketProvider: ({ children }: any) => <>{children}</> }));
vi.mock('../ActiveProject', () => ({ ActiveProjectProvider: ({ children }: any) => <>{children}</> }));

const { isDesktop } = vi.hoisted(() => ({ isDesktop: vi.fn() }));
vi.mock('../desktop', () => ({ isDesktop }));

beforeEach(() => { delete document.documentElement.dataset.shell; });
afterEach(() => { cleanup(); vi.clearAllMocks(); delete document.documentElement.dataset.shell; });

describe('which shell claims the document', () => {
  it('leaves the browser alone, so the page can still scroll', () => {
    /*
     * THE test. A rule that reaches the browser hides most of the board with
     * no route to it, and the failure is invisible in this repo's own tooling:
     * jsdom cannot see it, and the UI suite does not run in CI at all.
     */
    isDesktop.mockReturnValue(false);
    render(<App />);
    expect(
      document.documentElement.dataset.shell,
      'the desktop no-scroll rule was applied to the browser',
    ).toBeUndefined();
  });

  it('claims the document in the Electron shell, where the window is ours', () => {
    isDesktop.mockReturnValue(true);
    render(<App />);
    expect(document.documentElement.dataset.shell).toBe('desktop');
  });

  it('gives the document back when the shell unmounts', () => {
    // Otherwise a test, a hot reload, or anything that remounts leaves the
    // stamp behind and the browser inherits a rule meant for a window.
    isDesktop.mockReturnValue(true);
    const { unmount } = render(<App />);
    unmount();
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});

describe('the half CSS cannot do', () => {
  it('pins the document back when something scrolls it programmatically', () => {
    /*
     * `overflow: hidden` stops the USER scrolling. It does not stop
     * `scrollIntoView`, which the board calls to reveal a card — that moved the
     * document 386px in a real window, and then nothing could move it back: no
     * scrollbar, no wheel, and overscroll-behavior killed the gesture. The
     * ceiling alone turned a recoverable annoyance into an unrecoverable one.
     */
    isDesktop.mockReturnValue(true);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(<App />);

    Object.defineProperty(window, 'scrollY', { value: 386, configurable: true });
    window.dispatchEvent(new Event('scroll'));

    expect(scrollTo, 'the shell was left stranded after a programmatic scroll').toHaveBeenCalledWith(0, 0);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    scrollTo.mockRestore();
  });

  it('does not fight a document that has not moved', () => {
    // A pane scrolling INSIDE itself never moves the document, so this handler
    // must stay silent for the scrolling that happens all the time.
    isDesktop.mockReturnValue(true);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(<App />);

    window.dispatchEvent(new Event('scroll'));

    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  it('listens only in the shell', () => {
    isDesktop.mockReturnValue(false);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    render(<App />);

    Object.defineProperty(window, 'scrollY', { value: 386, configurable: true });
    window.dispatchEvent(new Event('scroll'));

    expect(scrollTo, 'the browser had its scroll position taken away').not.toHaveBeenCalled();
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    scrollTo.mockRestore();
  });
});
