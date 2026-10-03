/**
 * The editors' own marks (CGLAB-187).
 *
 * Sibling of AgentIcon, and inline for the same reason: the renderer runs under
 * a strict CSP with no external hosts, and a packaged app has no network
 * guarantee — a remote logo would be a blank square on exactly the machines
 * this app is for.
 *
 * PROVENANCE, because "the real thing" is the whole point and a wrong logo is
 * worse than none — it lies about which program is about to open:
 *
 *  - VS Code comes from devicon (`icons/vscode/vscode-plain.svg`). It is NOT in
 *    simple-icons: that slug 404s, because they removed Microsoft's mark on
 *    trademark grounds. The tempting substitute there is VSCodium, which is a
 *    DIFFERENT PRODUCT — exactly the stand-in AgentIcon warns about.
 *  - Cursor and Zed come from simple-icons (`cursor`, `zedindustries`).
 *
 * Which is why `viewBox` is per-mark rather than assumed: devicon draws on a
 * 128 grid and simple-icons on 24. AgentIcon can assume 24 because all five of
 * its marks come from one set; this one cannot, and hardcoding either number
 * would silently scale two of the three logos wrong.
 */
import React from 'react';

interface Mark {
  /** The grid the path was drawn on. Not assumed — the sets disagree. */
  readonly viewBox: string;
  /**
   * A brand hex, or `currentColor` where the mark is monochrome by design.
   *
   * Zed's is the latter: its mark is a letterform, black on light and white on
   * dark rather than a colour, so it inherits the surrounding text instead of
   * being pinned to one that would be wrong in half the themes.
   */
  readonly color: string;
  readonly path: string;
}

const MARKS: Record<string, Mark> = {
  vscode: {
    viewBox: '0 0 128 128',
    // From the full-colour original, which layers this silhouette over two
    // blues; at 12px the layering is invisible and the darker one reads better.
    color: '#007ACC',
    path: 'M90.767 127.126a7.968 7.968 0 0 0 6.35-.244l26.353-12.681a8 8 0 0 0 4.53-7.209V21.009a8 8 0 0 0-4.53-7.21L97.117 1.12a7.97 7.97 0 0 0-9.093 1.548l-50.45 46.026L15.6 32.013a5.328 5.328 0 0 0-6.807.302l-7.048 6.411a5.335 5.335 0 0 0-.006 7.888L20.796 64 1.74 81.387a5.336 5.336 0 0 0 .006 7.887l7.048 6.411a5.327 5.327 0 0 0 6.807.303l21.974-16.68 50.45 46.025a7.96 7.96 0 0 0 2.743 1.793Zm5.252-92.183L57.74 64l38.28 29.058V34.943Z',
  },
  cursor: {
    viewBox: '0 0 24 24',
    color: 'currentColor',
    path: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
  },
  zed: {
    viewBox: '0 0 24 24',
    color: 'currentColor',
    path: 'M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z',
  },
};

/** The ids that have a mark. Exported so a test can catch drift from the main process. */
export const EDITOR_MARK_IDS = Object.keys(MARKS);

/**
 * Draw an editor's mark.
 *
 * Returns nothing for an id it does not know, rather than a placeholder. The
 * editor list is a closed set decided in the main process, so an unknown id
 * means the two have drifted — and a generic square would hide that while
 * telling the user something false about which program opens.
 *
 * `aria-hidden` because the button says the editor's name in text right beside
 * it; announcing it twice is worse than not announcing it at all.
 */
export function EditorIcon({ editorId, size = 12 }: { editorId: string; size?: number }): React.ReactElement | null {
  const mark = MARKS[editorId];
  if (!mark) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill={mark.color}
      aria-hidden="true"
      data-editor-mark={editorId}
      className="shrink-0"
    >
      <path d={mark.path} />
    </svg>
  );
}
