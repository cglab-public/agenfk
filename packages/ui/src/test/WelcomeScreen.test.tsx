/**
 * The window with nothing in it (004bd193).
 *
 * The first thing a new user sees, and the screen nobody thinks about: left
 * alone it is an empty grey rectangle, which reads as broken rather than as
 * new.
 *
 * MOST OF THIS FILE IS ABOUT THE ACTIONS BEING REAL. A logo over a list of
 * controls is easy to build and easy to get wrong in one specific way - by
 * offering routes that do not exist. This is the screen where somebody is most
 * likely to press whatever is in front of them, so a dead button here costs
 * more than a shorter list would have.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WelcomeScreen, welcomeActions } from '../components/WelcomeScreen';

afterEach(cleanup);

/** Everything wired, which is the state once a project exists. */
const handlers = () => ({
  onNewProject: vi.fn(),
  onImportGitHub: vi.fn(),
  onImportJira: vi.fn(),
});

describe('every action goes somewhere', () => {
  it('runs the handler it was given, for every one of them', () => {
    /*
     * THE test. Written over the whole list rather than one action at a time,
     * so a fourth entry added without a handler fails here instead of being
     * discovered by whoever presses it.
     */
    const h = handlers();
    const actions = welcomeActions(h);
    render(<WelcomeScreen actions={actions} />);

    for (const action of actions) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(action.label, 'i') }));
    }

    for (const [name, fn] of Object.entries(h)) {
      expect(fn, `${name} was never reached by any button`).toHaveBeenCalledTimes(1);
    }
  });

  it('offers nothing the app cannot do', () => {
    /*
     * The reference this was drawn from also lists "Clone from GitHub" and
     * "Add remote project". Neither has a route in this app, so neither is
     * here. This pins that decision: the list is what works, not what the
     * mockup showed.
     */
    render(<WelcomeScreen actions={welcomeActions(handlers())} />);
    expect(screen.queryByRole('button', { name: /clone/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remote/i })).toBeNull();
  });

  it('leaves out the imports when there is nowhere to import INTO', () => {
    /*
     * The case this screen exists for. Both import dialogs take a projectId
     * and cannot run without one, so with no projects they are exactly the
     * dead control this screen is most likely to have pressed.
     *
     * A shorter list that works beats a longer one that matches a mockup - and
     * the mockup is where the pressure to show four entries comes from.
     */
    const onNewProject = vi.fn();
    render(<WelcomeScreen actions={welcomeActions({ onNewProject })} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /import/i })).toBeNull();
    expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
  });

  it('is a list, so a screen reader can count what is on offer', () => {
    // Three unrelated buttons floating in a div say nothing about being a set
    // of alternatives; a list says how many choices there are before you walk
    // them.
    render(<WelcomeScreen actions={welcomeActions(handlers())} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('what the screen says it is', () => {
  it('names the app, since the mark is the only thing identifying it here', () => {
    /*
     * Everywhere else the mark sits beside something that says what this is.
     * Alone at this size it IS the identification, so an unnamed image would
     * leave a screen reader with a window that never introduces itself.
     */
    render(<WelcomeScreen actions={welcomeActions(handlers())} />);
    expect(screen.getByRole('img', { name: 'AgEnFK' })).toBeInTheDocument();
  });

  it('says what each action does, not just what it is called', () => {
    // The label is the verb; the description is the consequence, which is the
    // half somebody who has never used this actually needs.
    render(<WelcomeScreen actions={welcomeActions(handlers())} />);
    expect(screen.getByText(/start from a directory on this machine/i)).toBeInTheDocument();
  });

  it('renders nothing extra when there is nothing to offer', () => {
    // A defensive case that is really about the shell: if it ever passes an
    // empty list, this must be an empty screen rather than a broken one.
    render(<WelcomeScreen actions={[]} />);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    expect(screen.getByRole('img', { name: 'AgEnFK' })).toBeInTheDocument();
  });
});
