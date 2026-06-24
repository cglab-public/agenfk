/**
 * Tests for the built-in TOON (Token-Oriented Object Notation) encoder.
 *
 * TOON trims repeated JSON keys to save tokens:
 *   - arrays of uniform scalar objects render as a tabular block with one
 *     header row of field names and comma-separated value rows
 *   - scalars render bare unless they need quoting (delimiters, type ambiguity)
 */

import { describe, it, expect } from 'vitest';
import { toonEncode } from '../toon';

describe('toonEncode — scalars and quoting', () => {
  it('renders bare scalars', () => {
    expect(toonEncode({ a: 'hello world', c: 42, d: true, e: null })).toBe(
      ['a: hello world', 'c: 42', 'd: true', 'e: null'].join('\n')
    );
  });

  it('quotes strings containing the delimiter, and empty strings', () => {
    expect(toonEncode({ b: 'has,comma', f: '' })).toBe(
      ['b: "has,comma"', 'f: ""'].join('\n')
    );
  });

  it('quotes strings containing a colon or newline', () => {
    expect(toonEncode({ a: 'key: val', b: 'line1\nline2' })).toBe(
      ['a: "key: val"', 'b: "line1\\nline2"'].join('\n')
    );
  });

  it('quotes strings that would otherwise be read as a number/boolean/null', () => {
    expect(toonEncode({ s: '42', t: 'true', n: 'null', num: 42 })).toBe(
      ['s: "42"', 't: "true"', 'n: "null"', 'num: 42'].join('\n')
    );
  });

  it('quotes strings with leading/trailing whitespace', () => {
    expect(toonEncode({ a: ' padded ' })).toBe('a: " padded "');
  });

  it('encodes a top-level scalar', () => {
    expect(toonEncode('hi')).toBe('hi');
    expect(toonEncode(7)).toBe('7');
  });

  it('treats undefined as null without crashing', () => {
    expect(toonEncode({ a: undefined, b: 1 })).toBe(['a: null', 'b: 1'].join('\n'));
    expect(toonEncode(undefined)).toBe('null');
  });
});

describe('toonEncode — arrays', () => {
  it('renders a top-level array of uniform scalar objects as a table', () => {
    const data = [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
    ];
    expect(toonEncode(data)).toBe(
      ['[2]{id,name,role}:', '  1,Alice,admin', '  2,Bob,user'].join('\n')
    );
  });

  it('renders a keyed array of uniform scalar objects as a table', () => {
    const data = { name: 'TDD Flow', steps: [{ order: 1, name: 'todo' }, { order: 2, name: 'done' }] };
    expect(toonEncode(data)).toBe(
      ['name: TDD Flow', 'steps[2]{order,name}:', '  1,todo', '  2,done'].join('\n')
    );
  });

  it('renders an array of primitives inline', () => {
    expect(toonEncode({ tags: ['a', 'b', 'c'] })).toBe('tags[3]: a,b,c');
  });

  it('renders an empty array', () => {
    expect(toonEncode({ items: [] })).toBe('items[0]:');
  });

  it('quotes scalar values inside table rows when needed', () => {
    const data = [{ id: 1, title: 'a,b' }, { id: 2, title: 'plain' }];
    expect(toonEncode(data)).toBe(
      ['[2]{id,title}:', '  1,"a,b"', '  2,plain'].join('\n')
    );
  });
});

describe('toonEncode — fallback list form', () => {
  it('falls back to a list when object keys are not uniform', () => {
    expect(toonEncode({ xs: [{ a: 1 }, { b: 2 }] })).toBe(
      ['xs[2]:', '  - a: 1', '  - b: 2'].join('\n')
    );
  });

  it('falls back to a list when an element has a non-scalar value, nesting recursively', () => {
    expect(toonEncode([{ id: 1, tags: ['x', 'y'] }])).toBe(
      ['[1]:', '  - id: 1', '    tags[2]: x,y'].join('\n')
    );
  });

  it('does NOT use the table form when a key is not delimiter-safe (avoids ambiguous header)', () => {
    // A key containing a comma would corrupt the {a,b,c} header — must fall back to list form.
    const data = [{ 'a,b': 1, c: 2 }];
    const out = toonEncode(data);
    expect(out).not.toMatch(/\{a,b,c\}/);
    expect(out).toMatch(/\[1\]:/); // list fallback header
  });

  it('renders nested objects under their key', () => {
    expect(toonEncode({ outer: { inner: 1, deep: { x: 2 } } })).toBe(
      ['outer:', '  inner: 1', '  deep:', '    x: 2'].join('\n')
    );
  });
});
