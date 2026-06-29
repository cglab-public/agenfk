import { describe, it, expect } from 'vitest';
import { clampRowLimit, formatCell } from '../queryConsole';

describe('clampRowLimit', () => {
  it('defaults when value is missing or invalid', () => {
    expect(clampRowLimit(undefined)).toBe(1000);
    expect(clampRowLimit('abc')).toBe(1000);
    expect(clampRowLimit(0)).toBe(1000);
    expect(clampRowLimit(-5)).toBe(1000);
  });
  it('passes through a valid value', () => {
    expect(clampRowLimit(50)).toBe(50);
    expect(clampRowLimit('250')).toBe(250);
  });
  it('caps at the maximum', () => {
    expect(clampRowLimit(999999)).toBe(5000);
  });
});

describe('formatCell', () => {
  it('renders null/undefined as NULL', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(undefined)).toBe('NULL');
  });
  it('renders booleans and numbers', () => {
    expect(formatCell(true)).toBe('true');
    expect(formatCell(0)).toBe('0');
    expect(formatCell(42)).toBe('42');
  });
  it('JSON-stringifies objects and arrays', () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell([1, 2])).toBe('[1,2]');
  });
  it('passes strings through', () => {
    expect(formatCell('hello')).toBe('hello');
  });
});
