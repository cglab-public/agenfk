/**
 * Back to the top of the page. Inside the app shell the content pane scrolls,
 * not the window (the sidebar stays put), so that pane is moved; pages outside
 * the shell (login, setup) still scroll the window.
 */
export function scrollPageToTop(): void {
  const root = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-scroll-root]') : null;
  if (root) root.scrollTop = 0;
  window.scrollTo(0, 0);
}
