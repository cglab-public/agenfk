/**
 * INFRA-425: the terminal header names the project.
 *
 * TerminalTab has always rendered `projectName / title`, and nothing ever set
 * `projectName`, so the header read only the card's title — or, for a project
 * terminal, the project's name with nothing to say it was one. The name is
 * derived where it is shown rather than stored on the session, so a session
 * restored from before this change gets it too.
 */
import { describe, it, expect } from 'vitest';
import { withProjectNames } from '../sessionProject';

const names = new Map([['p1', 'aws-org-infra'], ['p2', 'agenfk']]);
const itemProject = new Map([['card-1', 'p1']]);

describe('naming the project of each terminal', () => {
  it('names a card terminal after the card\'s project', () => {
    const [s] = withProjectNames([{ id: 's1', itemId: 'card-1', title: 'Fix it' }], itemProject, names);
    expect(s.projectName).toBe('aws-org-infra');
  });

  it('names a project terminal after its project', () => {
    const [s] = withProjectNames([{ id: 's2', projectId: 'p2', title: 'Shell 1' }], itemProject, names);
    expect(s.projectName).toBe('agenfk');
  });

  it('does not repeat the name of a project terminal already titled with it', () => {
    const session = { id: 's2b', projectId: 'p2', title: 'agenfk' };
    const [s] = withProjectNames([session], itemProject, names);
    expect(s).toBe(session);
  });

  it('prefers the session\'s own project over the card lookup', () => {
    const [s] = withProjectNames([{ id: 's3', itemId: 'card-1', projectId: 'p2', title: 'x' }], itemProject, names);
    expect(s.projectName).toBe('agenfk');
  });

  it('leaves a session it cannot place exactly as it was', () => {
    const session = { id: 's4', itemId: 'unknown', title: 'x' };
    const [s] = withProjectNames([session], itemProject, names);
    expect(s).toBe(session);
  });

  it('returns the same array when nothing changed, so React sees no new props', () => {
    const sessions = [{ id: 's5', title: 'shell' }];
    expect(withProjectNames(sessions, itemProject, names)).toBe(sessions);
  });
});
