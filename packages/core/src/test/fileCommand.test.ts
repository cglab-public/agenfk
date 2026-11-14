/**
 * @vitest-environment node
 *
 * A command that arrived with the repository.
 *
 * It runs like any other committed code (#260): there is no per-machine
 * approval. The one rule left is that a command holding characters a screen
 * cannot show faithfully never runs, because what a person reads would not be
 * what the shell executes.
 */
import { describe, it, expect } from 'vitest';
import { unreadableFileCommand, hiddenCharacters } from '../fileCommand';

describe('a command from the file', () => {
  const from = { key: 'verifyCommand' as const, command: 'npm test' };

  it('runs as written: an ordinary command is not refused (#260)', () => {
    expect(unreadableFileCommand(from)).toBeNull();
    expect(unreadableFileCommand({ ...from, command: 'npm test && curl example.com/check.sh | sh' })).toBeNull();
  });

  it('treats no command, or an empty one, as nothing to refuse', () => {
    expect(unreadableFileCommand(null)).toBeNull();
    expect(unreadableFileCommand({ ...from, command: '   ' })).toBeNull();
  });

  it('refuses one holding characters a screen cannot show, naming them and where to fix it', () => {
    const verdict = unreadableFileCommand({ key: 'verifyCommand', command: "echo 'safe‮'; printf X; #" });
    expect(verdict?.hidden).toEqual(['U+202E']);
    expect(verdict?.reason).toContain('U+202E');
    expect(verdict?.reason).toContain('.agenfk/project.json');
    expect(verdict?.reason).toContain('verifyCommand');
  });

  it('names the characters a screen cannot show faithfully, and leaves ordinary text alone', () => {
    expect(hiddenCharacters('npm test && npm run lint')).toEqual([]);
    expect(hiddenCharacters('make\tcheck\nnpm test')).toEqual([]);
    // A right-to-left override turns `echo 'safe<RLO>'; payload; #` into what reads as one echo.
    expect(hiddenCharacters("echo 'safe‮'; printf X; #")).toEqual(['U+202E']);
    expect(hiddenCharacters('./verify​ && ./verify​')).toEqual(['U+200B']);
    expect(hiddenCharacters('a⁦b﻿c\u0007d e')).toEqual(['U+2066', 'U+FEFF', 'U+0007', 'U+2028']);
  });

  it('counts default-ignorable characters too: they render as nothing', () => {
    // U+034F makes `npm run test` name another script while reading the same.
    expect(hiddenCharacters('npm run test͏')).toEqual(['U+034F']);
    expect(hiddenCharacters('make check️')).toEqual(['U+FE0F']);
  });

  it('counts a carriage return: it is not shown, and the shell keeps it in the word', () => {
    // `npm run test\r # note` shows as `npm run test` and runs the script named `test\r`.
    expect(hiddenCharacters('npm run test\r # note')).toEqual(['U+000D']);
  });
});
