/**
 * @vitest-environment node
 *
 * What a repository may declare about its own project.
 *
 * `.agenfk/project.json` is checked in, so everything it says travels to
 * whoever clones — which is the point, and also the whole risk. The rules
 * pinned here came from reading the real database rather than from theory:
 * three flows share the name "TDD Flow" with different ids, one project's
 * root is an absolute path under one person's home, and a real verifyCommand
 * carries a hard-coded nvm PATH.
 */
import { describe, it, expect } from 'vitest';
import { readProjectFile, mergeProjectSettings, flowReference } from '../projectFile';

const file = (o: unknown): string => JSON.stringify(o);

describe('what the file may declare', () => {
  it('keeps the id it always carried', () => {
    const { value } = readProjectFile(file({ projectId: 'p1' }));
    expect(value.projectId).toBe('p1');
  });

  it('carries the settings that describe the project', () => {
    const { value, problems } = readProjectFile(file({
      projectId: 'p1',
      name: 'horizon-lab',
      flow: 'TDD Flow',
      autoWorktree: true,
      askBeforeCommit: true,
      verifyCommand: 'npm test',
      setupCommand: 'npm ci',
    }));
    expect(problems).toEqual([]);
    expect(value.settings).toEqual({
      name: 'horizon-lab',
      flow: 'TDD Flow',
      autoWorktree: true,
      askBeforeCommit: true,
      verifyCommand: 'npm test',
      setupCommand: 'npm ci',
    });
  });

  it('refuses a machine path, and says why', () => {
    // The file is found BECAUSE you are already in the folder; a root written
    // inside it is circular here and wrong on anybody else's machine.
    const { value, problems } = readProjectFile(file({
      projectId: 'p1',
      projectRoot: '/Users/leonardorosa/GitHub/horizon-lab',
      worktreeRoot: '/Users/leonardorosa/.agenfk-worktrees',
    }));
    // Not merely absent from the answer: not a key this type has at all.
    expect('projectRoot' in value.settings).toBe(false);
    expect(problems.join(' ')).toMatch(/projectRoot.*this machine/i);
    expect(problems.join(' ')).toMatch(/worktreeRoot/);
  });

  it('accepts a hub reference, which is the one id that travels', () => {
    // A flow installed from the hub carries `source: 'hub'` and a `hubFlowId`,
    // and THAT id means the same thing on every machine.
    const { value, problems } = readProjectFile(file({
      projectId: 'p1', flow: 'hub:47719f30-62d2-4048-a227-23e125774e3c',
    }));
    expect(problems).toEqual([]);
    expect(flowReference(value.settings.flow)).toEqual({
      kind: 'hub', hubFlowId: '47719f30-62d2-4048-a227-23e125774e3c',
    });
  });

  it('reads a plain string as the flow’s name', () => {
    const { value } = readProjectFile(file({ projectId: 'p1', flow: 'TDD Flow' }));
    expect(flowReference(value.settings.flow)).toEqual({ kind: 'name', name: 'TDD Flow' });
  });

  it('refuses a flow given by a BARE id, because that is a row in one machine’s database', () => {
    // Three flows on this machine are called "TDD Flow" with different ids.
    // Committing one hands whoever clones a pointer to nothing.
    const { value, problems } = readProjectFile(file({
      projectId: 'p1', flow: '608cf282-0415-4a26-ba45-24d72bd8024c',
    }));
    expect(value.settings.flow).toBeUndefined();
    expect(problems.join(' ')).toMatch(/hub:<id>|flow's name/i);
  });

  it('refuses a command carrying somebody’s home directory', () => {
    // The real one: `cd /Users/leonardorosa/... && PATH=/Users/.../nvm/... vitest run`.
    // Committed, it breaks for everyone else.
    const { value, problems } = readProjectFile(file({
      projectId: 'p1',
      verifyCommand: 'cd /Users/leonardorosa/GitHub/horizon-lab/apps/web && vitest run',
    }));
    expect(value.settings.verifyCommand).toBeUndefined();
    expect(problems.join(' ')).toMatch(/absolute path|home/i);
  });

  it('ignores a key it does not know, and says so rather than failing', () => {
    // A file written by a newer version must not stop an older one working.
    const { value, problems } = readProjectFile(file({ projectId: 'p1', futureThing: 1 }));
    expect(value.projectId).toBe('p1');
    expect(problems.join(' ')).toMatch(/futureThing/);
  });

  it('answers with problems, never a throw, for a file that is not JSON', () => {
    const { value, problems } = readProjectFile('{ not json');
    expect(value.projectId).toBeNull();
    expect(problems.join(' ')).toMatch(/could not be read/i);
  });

  it('refuses a value of the wrong type instead of coercing it', () => {
    const { value, problems } = readProjectFile(file({ projectId: 'p1', autoWorktree: 'yes' }));
    expect(value.settings.autoWorktree).toBeUndefined();
    expect(problems.join(' ')).toMatch(/autoWorktree/);
  });
});

describe('who wins', () => {
  const stored = {
    name: 'stored name',
    autoWorktree: false,
    verifyCommand: 'make check',
    setupCommand: 'make deps',
  };

  it('the file, for the keys it names', () => {
    const merged = mergeProjectSettings({ autoWorktree: true }, stored);
    expect(merged.value.autoWorktree).toBe(true);
    expect(merged.fromFile).toEqual(['autoWorktree']);
  });

  it('the database, for everything the file is silent about', () => {
    const merged = mergeProjectSettings({ autoWorktree: true }, stored);
    expect(merged.value.verifyCommand).toBe('make check');
    expect(merged.value.name).toBe('stored name');
  });

  it('says which keys came from the file, so the screen can stop offering to edit them', () => {
    const merged = mergeProjectSettings(
      { autoWorktree: true, verifyCommand: 'npm test' },
      stored,
    );
    expect(merged.fromFile.sort()).toEqual(['autoWorktree', 'verifyCommand']);
  });

  it('treats an absent file as no opinion at all, not as empty values', () => {
    // A project with no file must keep every stored setting it has.
    const merged = mergeProjectSettings(null, stored);
    expect(merged.value).toEqual(stored);
    expect(merged.fromFile).toEqual([]);
  });
});
