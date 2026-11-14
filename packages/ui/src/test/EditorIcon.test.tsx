/**
 * The editors' marks (CGLAB-187).
 *
 * The claim these tests protect is provenance, not pixels: a wrong logo is
 * worse than no logo, because it says the wrong program is about to open.
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { EditorIcon, EDITOR_MARK_IDS } from '../components/EditorIcon';
import { EDITORS } from '../../../desktop/src/main/editors';

afterEach(cleanup);

describe('drawing an editor mark', () => {
  it('draws one for every editor the desktop can offer', () => {
    /*
     * The drift check, and it is the reason this test exists at all. The
     * editor list is decided in the MAIN process; the marks live here. Two
     * lists written separately, each tested against its own fixture, agreeing
     * with nobody, is the failure this epic produced more than once — the
     * agent picker shipped a dead `supportsAutoApprove` exactly that way.
     */
    for (const editor of EDITORS) {
      expect(EDITOR_MARK_IDS, `no mark for "${editor.id}", which the desktop offers`).toContain(editor.id);
    }
  });

  it('uses the grid its own source drew on', () => {
    // Not assumed. VS Code comes from devicon, on a 128 grid; Cursor and Zed
    // from simple-icons, on 24. Hardcoding either would silently scale two of
    // the three logos wrong.
    const { container: vscode } = render(<EditorIcon editorId="vscode" />);
    expect(vscode.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 128 128');
    cleanup();
    const { container: cursor } = render(<EditorIcon editorId="cursor" />);
    expect(cursor.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('draws nothing for an id it does not know', () => {
    // Rather than a placeholder. An unknown id means this list and the main
    // process have drifted, and a generic square would hide that while telling
    // the user something false about which program opens.
    const { container } = render(<EditorIcon editorId="notepad" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('says nothing to a screen reader, because the button already does', () => {
    const { container } = render(<EditorIcon editorId="zed" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries a path, not an empty shell', () => {
    // Cheap, and it catches the one mistake that makes a logo silently vanish:
    // a mark entry added with no path data.
    for (const id of EDITOR_MARK_IDS) {
      cleanup();
      render(<EditorIcon editorId={id} />);
      const d = document.querySelector(`[data-editor-mark="${id}"] path`)?.getAttribute('d') ?? '';
      expect(d.length, `the mark for "${id}" has no path`).toBeGreaterThan(50);
    }
    expect(screen).toBeTruthy();
  });
});
