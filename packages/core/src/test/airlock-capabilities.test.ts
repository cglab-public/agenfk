/**
 * @vitest-environment node
 *
 * What a tool call can do is read from its ARGUMENT KEYS, never its name: a
 * plugin tool the framework has never heard of is judged by the command, path
 * or URL it carries.
 */
import { describe, it, expect } from 'vitest';
import { capabilitiesOf } from '../airlock';

describe('capabilitiesOf', () => {
  it('extracts command/path/url by key, skips xd://, unwraps local://', () => {
    expect(capabilitiesOf({ command: 'ls -la' })).toEqual([{ kind: 'command', command: 'ls -la' }]);
    expect(capabilitiesOf({ cmd: 'echo hi' })).toEqual([{ kind: 'command', command: 'echo hi' }]);

    expect(capabilitiesOf({ path: '/a' })).toEqual([{ kind: 'path', path: '/a', access: 'read' }]);
    expect(capabilitiesOf({ file_path: '/b' })).toEqual([{ kind: 'path', path: '/b', access: 'read' }]);
    expect(capabilitiesOf({ filePath: '/c' })).toEqual([{ kind: 'path', path: '/c', access: 'read' }]);
    expect(capabilitiesOf({ notebook_path: '/d.ipynb', new_source: 'x' })).toEqual([
      { kind: 'path', path: '/d.ipynb', access: 'write' },
    ]);
    expect(capabilitiesOf({ paths: ['/e', 'xd://skip', 'local:///f', 7] })).toEqual([
      { kind: 'path', path: '/e', access: 'read' },
      { kind: 'path', path: '/f', access: 'read' },
    ]);
    expect(capabilitiesOf({ path: 'xd://whatever' })).toEqual([]);
    expect(capabilitiesOf({ path: 'local://notes.md' })).toEqual([
      { kind: 'path', path: 'notes.md', access: 'read' },
    ]);

    expect(capabilitiesOf({ url: 'https://a.example/' })).toEqual([{ kind: 'url', url: 'https://a.example/' }]);
    expect(capabilitiesOf({ uri: 'https://b.example/' })).toEqual([{ kind: 'url', url: 'https://b.example/' }]);
    expect(capabilitiesOf({ href: 'https://c.example/' })).toEqual([{ kind: 'url', url: 'https://c.example/' }]);
  });

  it('marks a path written when the call carries content to write', () => {
    expect(capabilitiesOf({ file_path: '/x', content: 'hi' })).toEqual([{ kind: 'path', path: '/x', access: 'write' }]);
    expect(capabilitiesOf({ file_path: '/x', old_string: 'a', new_string: 'b' })).toEqual([
      { kind: 'path', path: '/x', access: 'write' },
    ]);
    expect(capabilitiesOf({ file_path: '/x', edits: [] })).toEqual([{ kind: 'path', path: '/x', access: 'write' }]);
  });

  it('returns every capability a call carries, command first', () => {
    expect(capabilitiesOf({ url: 'https://u.example/', path: '/p', command: 'c' })).toEqual([
      { kind: 'command', command: 'c' },
      { kind: 'path', path: '/p', access: 'read' },
      { kind: 'url', url: 'https://u.example/' },
    ]);
  });

  it('ignores empty, non-string and unknown values', () => {
    expect(capabilitiesOf({ command: '', path: 42, url: null, content: 'x', name: 'bash' })).toEqual([]);
    expect(capabilitiesOf({ command: '   ' })).toEqual([]);
    expect(capabilitiesOf(null as unknown as Record<string, unknown>)).toEqual([]);
    expect(capabilitiesOf({ paths: 'not-an-array' })).toEqual([]);
  });

  it('reads arrays of command strings under command, cmd and commands', () => {
    expect(capabilitiesOf({ commands: ['curl http://169.254.169.254/', 7, ''] })).toEqual([
      { kind: 'command', command: 'curl http://169.254.169.254/' },
    ]);
    expect(capabilitiesOf({ command: ['a', 'b'], cmd: ['c'] })).toEqual([
      { kind: 'command', command: 'a' },
      { kind: 'command', command: 'b' },
      { kind: 'command', command: 'c' },
    ]);
    expect(capabilitiesOf({ commands: 'ls' })).toEqual([{ kind: 'command', command: 'ls' }]);
  });
});
