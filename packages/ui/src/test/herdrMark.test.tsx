/**
 * herdr's mark (96953f6a / CGLAB-266).
 *
 * A borrowed mark, so the tests are about not deforming it and not claiming it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { HerdrMark } from '../components/HerdrMark';

afterEach(cleanup);

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'HerdrMark.tsx'),
  'utf8',
);

describe('the mark itself', () => {
  it('is reachable as an image, and says whose it is', () => {
    render(<HerdrMark />);
    expect(screen.getByRole('img', { name: /herdr/i })).toBeTruthy();
  });

  it('keeps the 512 grid and the flip the original was drawn on', () => {
    /*
     * The path's coordinates only land correctly under this viewBox and this
     * transform. Changing either would not "adjust" the mark, it would deform
     * somebody else's logo.
     */
    render(<HerdrMark />);
    const svg = screen.getByRole('img', { name: /herdr/i });
    expect(svg.getAttribute('viewBox')).toBe('0 0 512 512');
    expect(svg.querySelector('g')?.getAttribute('transform')).toBe('translate(0 512) scale(.1 -.1)');
  });

  it('takes the colour of the text around it, inventing none', () => {
    // Every other glyph in that panel is a monochrome lucide icon. A two-tone
    // tile among them reads as a foreign object - and the original's own field
    // colour sits near 1.2:1 on a light background.
    render(<HerdrMark />);
    const svg = screen.getByRole('img');
    expect(svg.querySelector('g')?.getAttribute('fill')).toBe('currentColor');
    /*
     * The RENDERED mark, not the file: the docblock names the original's two
     * colours to explain the deviation, and the first version of this assertion
     * read the whole source and failed on its own comment.
     */
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(svg.querySelector('rect'), 'no tile, only the ram').toBeNull();
  });
});

describe('what the file must keep saying', () => {
  it('records where the path came from and under what licence', () => {
    /*
     * This is a borrowed mark. A future reader has to be able to tell that
     * without going looking, and a silent copy is how attribution gets lost.
     */
    expect(source).toMatch(/herdr/);
    expect(source).toMatch(/AGPL-3\.0/);
    expect(source).toMatch(/assets\/logo\.svg/);
  });

  it('says the silhouette was not redrawn', () => {
    expect(source).toMatch(/byte-for-byte|not redrawn/i);
  });
});
