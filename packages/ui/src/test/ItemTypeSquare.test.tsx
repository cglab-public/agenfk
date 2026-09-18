/**
 * @vitest-environment jsdom
 *
 * The type grammar people already read (CGLAB-164).
 *
 * The create form's type control was four bare words in a <select>. Four words
 * are four words: nothing distinguishes EPIC from TASK until you have read
 * both. Every tracker the team already uses — JIRA above all — says issue type
 * with a small FILLED square, one colour per type, a white glyph inside it, and
 * that pairing is recognised before the word is read.
 *
 * This is the grammar, not the dropdown: the <select> stays exactly where it
 * was. Only what sits beside it changes.
 */
import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { ItemTypeSquare, ITEM_TYPE_VISUAL, itemTypeHint } from '../components/ItemTypeSquare';
import { ItemType } from '../types';

afterEach(cleanup);

describe('the type grammar', () => {
  it('gives every type a square, so none of them falls back to a bare word', () => {
    for (const type of Object.values(ItemType)) {
      expect(ITEM_TYPE_VISUAL[type], `no visual for ${type}`).toBeTruthy();
    }
  });

  it('paints each type the colour that tracker carries: epic violet, story green, task blue, bug red', () => {
    // The colour is the half of the grammar that is recognised first, and these
    // four are the ones people arrive already knowing. Getting TASK and STORY
    // the wrong way round would be worse than having no colour at all.
    expect(ITEM_TYPE_VISUAL[ItemType.EPIC].fill).toMatch(/violet/);
    expect(ITEM_TYPE_VISUAL[ItemType.STORY].fill).toMatch(/emerald|green/);
    expect(ITEM_TYPE_VISUAL[ItemType.TASK].fill).toMatch(/blue/);
    expect(ITEM_TYPE_VISUAL[ItemType.BUG].fill).toMatch(/rose|red/);
  });

  it('gives no two types the same colour', () => {
    // A grammar where two types share a fill is a grammar that cannot be read
    // at a glance, which is the entire point of having one.
    const fills = Object.values(ItemType).map(t => ITEM_TYPE_VISUAL[t].fill);
    expect(new Set(fills).size).toBe(fills.length);
  });

  it('fills the square rather than tinting it, and puts a white glyph inside', () => {
    // An outlined or 10%-tinted chip is what the modal already had elsewhere.
    // The tracker grammar is a SOLID square with a white mark on it.
    const { container } = render(<ItemTypeSquare type={ItemType.TASK} />);
    const square = container.firstElementChild as HTMLElement;
    expect(square.className).toMatch(/bg-blue-\d{3}/);
    expect(square.className).not.toMatch(/\/10\b/);
    expect(square.className).toMatch(/text-white/);
    expect(square.querySelector('svg')).toBeTruthy();
  });

  it('stays out of the accessibility tree, because the control beside it already says the type', () => {
    // The square is a second rendering of a value the <select> already
    // announces. Announcing it twice is noise, not redundancy.
    const { container } = render(<ItemTypeSquare type={ItemType.BUG} />);
    expect((container.firstElementChild as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });

  it('draws a different glyph per type, so colour is not the only signal', () => {
    // Colour alone excludes anyone who cannot separate violet from blue.
    const glyphs = new Set<string>();
    for (const type of Object.values(ItemType)) {
      const { container } = render(<ItemTypeSquare type={type} />);
      const path = container.querySelector('svg')?.innerHTML ?? '';
      expect(path).not.toBe('');
      glyphs.add(path);
      cleanup();
    }
    expect(glyphs.size).toBe(Object.values(ItemType).length);
  });
});

describe('what each type costs you', () => {
  /*
   * The hint under the dropdown. It says what the type MEANS in this product,
   * and every sentence here is checkable against the server's own decomposition
   * rules (packages/server/src/index.ts, analyze_request): an EPIC is never
   * worked directly and must be decomposed into stories; a STORY is split into
   * tasks only when it is large.
   *
   * Deliberately NOT claimed: "a task gets a worktree and a branch, an epic
   * does not". The worktree code (packages/server/src/worktrees.ts) does not
   * gate on item type at all, so putting that on screen would be the UI
   * promising a rule the server does not keep.
   */
  it('says an epic is a container that is never worked directly', () => {
    expect(itemTypeHint(ItemType.EPIC)).toMatch(/never worked directly|container/i);
  });

  it('says a story splits into tasks only when it is large', () => {
    expect(itemTypeHint(ItemType.STORY)).toMatch(/task/i);
  });

  it('has a sentence for every type, so the hint never blinks out', () => {
    for (const type of Object.values(ItemType)) {
      expect(itemTypeHint(type).length, `no hint for ${type}`).toBeGreaterThan(0);
    }
  });

  it('does not promise a worktree or a branch, which nothing in the server gates on type', () => {
    for (const type of Object.values(ItemType)) {
      expect(itemTypeHint(type)).not.toMatch(/worktree/i);
    }
  });
});
