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
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { ItemTypeSquare, ItemTypeBadge, ITEM_TYPE_VISUAL, itemTypeHint } from '../components/ItemTypeSquare';
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

  it('is the only type grammar in the product — no component paints a type by hand', () => {
    /*
     * THE DEFECT THIS CHANGE SHIPPED TWICE, pinned where it actually lives.
     *
     * The draft's square said story=green / task=blue while the board, the
     * detail badge, the Subitems table and both import modals said
     * story=`story-blue` / task=`brand` teal. Four mappings at once, and the
     * one screen that TEACHES the colour→type mapping taught the reverse of
     * the screen the card lands on.
     *
     * The first version of this test asserted the retirement against
     * `ITEM_TYPE_VISUAL` itself — a string of four `bg-*-600` classes that
     * could never contain `story-blue` under any implementation. It was green
     * while `KanbanBoard`'s drill-down breadcrumb still painted the dot with
     * `bg-story-blue`: a FIFTH site, missed by the sweep and unreachable by
     * any assertion that only looks at this module.
     *
     * So this reads the components directory. The rule is narrow and about
     * intent: a colour token may not be CHOSEN BY ITEM TYPE outside
     * `ItemTypeSquare`. `--color-story-blue` and `--brand` keep their other
     * jobs (a TEST column's top border, an agent's tag) — what is banned is
     * using them to mean "this one is a STORY".
     */
    // Resolved from this file's own location, not from the runner's cwd: the
    // suite is run from the package root and from the monorepo root.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    /*
     * Every Tailwind palette and every utility that can carry a colour, not
     * the five prefixes and five hues the first version listed. A sweep that
     * only knows `bg-blue-600` waves `ring-purple-500` straight through, and
     * the next private palette will not be a copy of the last one.
     */
    const COLOUR = String.raw`(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}`;
    const BRAND = String.raw`story-blue|brand-light|bg-brand\/|text-brand\b|danger-muted|bg-chip|accent-text`;
    const retired = new RegExp(`${COLOUR}|${BRAND}`);

    /*
     * An item type named in code, in the two shapes that occur: the enum, and
     * a bare literal used as a key or compared against. The key form is what
     * `TYPE_COLORS = { EPIC: 'text-story-blue', … }` looked like — the exact
     * construct this change deleted from two files, and the one a line-scoped
     * version of this rule could not see.
     */
    const itemType = /ItemType\.(?:EPIC|STORY|TASK|BUG)\b|(?:^|[\s{,([])(?:['"]?)(?:EPIC|STORY|TASK|BUG)(?:['"]?)\s*[:?=]/;

    /*
     * A WINDOW, not a line. Prettier reflows a long `clsx` ternary across
     * three lines the moment someone adds a branch, and the defect this rule
     * exists for would have walked straight through a per-line check after any
     * reformat. The window is the unit a human reads as one decision.
     *
     * `// item-type-colour-ok` is the escape hatch, for the genuine case of a
     * type-conditional element that happens to sit next to an unrelated
     * colour. It is looked for in the LINES above the match, not inside the
     * byte window: the first version checked the window and the one real use
     * of it sat ~200 characters away — outside — so the marker suppressed
     * nothing and the site passed by accident, on padding. A hatch nobody can
     * reach is worse than no hatch, because it looks like one.
     */
    const WINDOW = 140;
    const offenders: string[] = [];

    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry.name) ? [full] : [];
      });

    for (const file of walk(root)) {
      if (file.endsWith('ItemTypeSquare.tsx') || file.includes(`${sep}test${sep}`)) continue;
      const raw = readFileSync(file, 'utf8');
      // Comments talk ABOUT the retired tints — this change's own history is
      // written in them — and a comment paints nothing.
      const source = raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/.*$/gm, m => ' '.repeat(m.length));
      const rawLines = raw.split('\n');
      const hits = [...source.matchAll(new RegExp(itemType, 'g'))];
      for (const hit of hits) {
        // Past the character the alternation consumed ahead of the type, so a
        // key at column 0 is not attributed to the line above it.
        const at = (hit.index ?? 0) + hit[0].length - hit[0].replace(/^[\s{,([]/, '').length;
        const window = source.slice(Math.max(0, at - WINDOW), at + WINDOW);
        if (!retired.test(window)) continue;
        const line = source.slice(0, at).split('\n').length;
        /*
         * The marker lives in a comment ABOVE the block, which is where a
         * person writes it — and comments are blanked out of `source`, so it
         * is looked for in the raw lines.
         *
         * Four lines and the match's own, and NOTHING below it. The first
         * version reached one line past the match, so a marker written under a
         * violation would have excused it — a suppression pointing the wrong
         * way, which is the hardest kind to notice in review.
         */
        const nearby = rawLines.slice(Math.max(0, line - 5), line).join('\n');
        if (nearby.includes('item-type-colour-ok')) continue;
        offenders.push(`${file.slice(root.length + 1)}:${line}: ${source.split('\n')[line - 1].trim()}`);
      }
    }

    expect([...new Set(offenders)], `a type's colour is decided outside ItemTypeSquare:\n${[...new Set(offenders)].join('\n')}`)
      .toEqual([]);
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

  it('degrades to a neutral square on a type it does not know, instead of throwing', () => {
    /*
     * Four call sites cast a plain string off the wire to `ItemType` — the two
     * import modals map a tracker's own issue types — so the compiler's
     * guarantee is gone exactly where the data is least trusted. An unknown
     * value used to read `undefined.fill` and take the whole screen down; a
     * grey square says "type unknown", which is true and survivable.
     */
    const { container } = render(<ItemTypeSquare type={'SPIKE' as ItemType} />);
    const square = container.firstElementChild as HTMLElement;
    expect(square).toBeTruthy();
    expect(square.className).toMatch(/bg-slate/);
    for (const type of Object.values(ItemType)) {
      expect(square.className).not.toContain(ITEM_TYPE_VISUAL[type].fill);
    }
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

describe('the badge every surface wears', () => {
  /*
   * One component, so the board, the card header, the Subitems table and the
   * import previews cannot drift into private palettes again. Each of those
   * used to build its own `clsx` ladder, and that is how three mappings ended
   * up on screen at the same time.
   */
  it('shows the square and the word together', () => {
    render(<ItemTypeBadge type={ItemType.STORY} />);
    const badge = screen.getByTestId('item-type-badge');
    expect(badge.textContent).toMatch(/STORY/);
    expect(badge.querySelector('svg')).toBeTruthy();
  });

  it('takes its colour from the grammar, never from a palette of its own', () => {
    for (const type of Object.values(ItemType)) {
      render(<ItemTypeBadge type={type} />);
      const square = screen.getByTestId('item-type-badge').firstElementChild as HTMLElement;
      expect(square.className, `${type} badge is not painted from ITEM_TYPE_VISUAL`)
        .toContain(ITEM_TYPE_VISUAL[type].fill);
      cleanup();
    }
  });

  it('carries exactly one text size, so no caller can lose a silent fight with the stylesheet', () => {
    /*
     * The badge used to hardcode `text-[10px]` and take a `className`, and the
     * two callers passed `text-xs` and `text-[9px]` through it. `clsx`
     * concatenates; it does not resolve conflicts, and Tailwind decides by the
     * order in the GENERATED stylesheet, where `.text-[10px]` comes last. So
     * both overrides were dead: the detail badge SHRANK to 10px and the board
     * badge GREW to 10px, and both call sites read as if they had worked.
     *
     * This repo already wrote that lesson down in `AgenfkFlag.tsx`, and
     * `tailwind-merge` sits in package.json unused. The fix here is to remove
     * the fight rather than arbitrate it: sizes are named, and there is no
     * `className` seam to pass a competing one through.
     */
    for (const size of ['sm', 'md'] as const) {
      render(<ItemTypeBadge type={ItemType.TASK} size={size} />);
      const badge = screen.getByTestId('item-type-badge');
      const sizes = badge.className.match(/(?:^|\s)text-(?:xs|sm|base|\[\d+px\])/g) ?? [];
      expect(sizes, `badge at size=${size} carries competing text sizes: ${badge.className}`)
        .toHaveLength(1);
      cleanup();
    }
  });

  it('scales the square with the badge, instead of keeping one fixed box', () => {
    // The square is what makes the badge tall. A 16px box inside a 9px chip is
    // why the board's rows grew when the badge landed on them.
    render(<ItemTypeBadge type={ItemType.TASK} size="sm" />);
    const small = (screen.getByTestId('item-type-badge').firstElementChild as HTMLElement).className;
    cleanup();
    render(<ItemTypeBadge type={ItemType.TASK} size="md" />);
    const medium = (screen.getByTestId('item-type-badge').firstElementChild as HTMLElement).className;
    expect(small).not.toBe(medium);
  });

  it('says the type in words as well as in colour', () => {
    // The square is aria-hidden, so the word is the whole accessible content.
    // A badge that lost it would be a coloured box and nothing else.
    for (const type of Object.values(ItemType)) {
      render(<ItemTypeBadge type={type} />);
      expect(screen.getByTestId('item-type-badge').textContent).toContain(type);
      cleanup();
    }
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
    // The `|container` leg was here and made the assertion unkillable: the
    // word "container" alone satisfied it while the rule that matters — an
    // epic must be decomposed before anything under it starts — could be
    // dropped entirely.
    expect(itemTypeHint(ItemType.EPIC)).toMatch(/never worked directly/i);
  });

  it('says a story splits into tasks only when it is large', () => {
    /*
     * Both halves. `/task/i` alone was satisfied by the exact OPPOSITE of the
     * rule — "Never split a story into tasks." matches it and is green. The
     * condition is the load-bearing part, and it is what the server states.
     */
    expect(itemTypeHint(ItemType.STORY)).toMatch(/task/i);
    expect(itemTypeHint(ItemType.STORY)).toMatch(/only when it is large/i);
  });

  it('has a sentence for every type, so the hint never blinks out', () => {
    for (const type of Object.values(ItemType)) {
      expect(itemTypeHint(type).length, `no hint for ${type}`).toBeGreaterThan(0);
    }
  });

  it('does not promise a worktree or a branch, which nothing in the server gates on type', () => {
    /*
     * BOTH nouns, because the name promised both and only one was checked:
     * "A task gets its own branch." passed a `/worktree/i`-only assertion and
     * is false — `packages/server/src/worktrees.ts` does not mention item type
     * once, so neither a worktree nor a branch is decided by what you pick in
     * this dropdown.
     */
    for (const type of Object.values(ItemType)) {
      expect(itemTypeHint(type), `${type} promises a worktree`).not.toMatch(/worktree/i);
      expect(itemTypeHint(type), `${type} promises a branch`).not.toMatch(/branch/i);
    }
  });
});
