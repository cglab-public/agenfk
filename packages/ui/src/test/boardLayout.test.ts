/**
 * #262 - the board's per-viewer layout choices: compact mode and which side columns are expanded.
 * Kept in this browser only; storage that is missing, corrupt or throwing gives the defaults.
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readBoardLayout, writeBoardLayout, DEFAULT_BOARD_LAYOUT } from '../boardLayout';

describe('board layout preferences', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to normal density with every side column collapsed', () => {
    expect(readBoardLayout()).toEqual(DEFAULT_BOARD_LAYOUT);
    expect(DEFAULT_BOARD_LAYOUT).toEqual({ compact: false, collapsed: { ideas: true, paused: true, blocked: true, archived: true } });
  });

  it('reads back what was written', () => {
    writeBoardLayout({ compact: true, collapsed: { ideas: true, paused: false, blocked: true, archived: true } });
    expect(readBoardLayout()).toEqual({ compact: true, collapsed: { ideas: true, paused: false, blocked: true, archived: true } });
  });

  it('gives the defaults for anything it cannot read, field by field', () => {
    localStorage.setItem('agenfk_board_layout', '{not json');
    expect(readBoardLayout()).toEqual(DEFAULT_BOARD_LAYOUT);
    localStorage.setItem('agenfk_board_layout', JSON.stringify({ compact: 'yes', collapsed: { paused: false, blocked: 3 } }));
    expect(readBoardLayout()).toEqual({ compact: false, collapsed: { ideas: true, paused: false, blocked: true, archived: true } });
  });

  it('survives storage that throws, reading the defaults and writing nothing', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(readBoardLayout()).toEqual(DEFAULT_BOARD_LAYOUT);
      expect(() => writeBoardLayout({ ...DEFAULT_BOARD_LAYOUT, compact: true })).not.toThrow();
    } finally { get.mockRestore(); set.mockRestore(); }
  });
});
