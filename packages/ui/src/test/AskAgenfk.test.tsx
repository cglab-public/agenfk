/**
 * @vitest-environment jsdom
 *
 * The screen behind the door that was drawn and disabled for three cards.
 *
 * What is pinned here is the promise, not the layout: nothing reaches the
 * board until the button at the bottom is pressed, the count on that button is
 * the number of cards that will actually exist, and a dropped parent takes its
 * children with it. Everything else is arrangement.
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AskAgenfk, seedCommand } from '../components/AskAgenfk';
import { api } from '../api';
import * as bridge from '../components/agentBridge';

// `vi.mock` is hoisted above every top-level binding, so the fakes have to be
// created inside the factory and read back afterwards.
vi.mock('../components/agentBridge', () => ({
  listAgentsFromBridge: vi.fn(),
  proposeFromBridge: vi.fn(),
  onProposeOutputFromBridge: vi.fn(),
  addProjectFromDirectory: vi.fn(),
  chooseProjectFolderFromBridge: vi.fn(),
  githubOwnersFromBridge: vi.fn(),
  createRepositoryFromBridge: vi.fn(),
  addChosenFolderFromBridge: vi.fn(),
  cloneDirFromBridge: vi.fn(),
  chooseCloneDirFromBridge: vi.fn(),
  cloneRepositoryFromBridge: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { reviewProposal: vi.fn(), createItem: vi.fn(), decompositionContract: vi.fn(), listProjects: vi.fn() },
}));

const PROPOSAL = {
  objective: 'port the admin API',
  contractVersion: 1,
  items: [
    { ref: 'e1', type: 'EPIC', title: 'Port the admin API', parentRef: null, depth: 0 },
    { ref: 's1', type: 'STORY', title: 'Move services private', parentRef: 'e1', depth: 1 },
    { ref: 't1', type: 'TASK', title: 'terraform port', parentRef: 's1', depth: 2 },
  ],
  issues: [],
};

const answer = JSON.stringify({ objective: 'x', items: [] });

beforeEach(() => {
  vi.clearAllMocks();
  (api.reviewProposal as any).mockResolvedValue(PROPOSAL);
  (api.createItem as any).mockImplementation(async (i: any) => ({ id: `id-${i.title}` }));
  (api.decompositionContract as any).mockResolvedValue('CONTRACT TEXT for the agent');
  (api.listProjects as any).mockResolvedValue([
    { id: 'p1', name: 'agenfk', projectRoot: '/checkout/agenfk' },
    { id: 'p2', name: 'horizon-lab', projectRoot: '/checkout/horizon' },
    { id: 'p3', name: 'no-folder' },
  ]);
  (bridge.listAgentsFromBridge as any).mockResolvedValue([
    { id: 'claude-code', label: 'Claude Code', available: true },
    { id: 'codex', label: 'Codex', available: false },
  ]);
  (bridge.cloneDirFromBridge as any).mockImplementation(() => Promise.resolve({ path: '/Users/me/GitHub' }));
  (bridge.githubOwnersFromBridge as any).mockImplementation(() => Promise.resolve([]));
  (bridge.onProposeOutputFromBridge as any).mockImplementation(() => () => {});
  (bridge.chooseCloneDirFromBridge as any).mockImplementation(() => Promise.resolve({ path: '/elsewhere' }));
  (bridge.cloneRepositoryFromBridge as any).mockImplementation(
    () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }),
  );
  (bridge.proposeFromBridge as any).mockImplementation(
    () => Promise.resolve({ stdout: JSON.stringify({ objective: 'x', items: [] }) }),
  );
});
afterEach(() => cleanup());

const open = () => render(<AskAgenfk projectId="p1" />);

const reviewWith = async (proposal: any = PROPOSAL) => {
  (api.reviewProposal as any).mockResolvedValue(proposal);
  open();
  fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: answer } });
  fireEvent.click(screen.getByTestId('ask-review'));
  await waitFor(() => screen.getByTestId('ask-tree'));
};

describe('asking', () => {
  it('shows the command it will run, rather than hiding it behind the button', () => {
    // This screen does not decompose anything — an agent does — so the person
    // should be able to read exactly what it is asked.
    open();
    fireEvent.change(screen.getByTestId('ask-objective'), { target: { value: 'add SSO' } });
    expect(screen.getByTestId('ask-command').textContent).toBe(seedCommand('add SSO'));
  });

  it('quotes an objective containing quotes', () => {
    expect(seedCommand('rename the "admin" API')).toContain('\\"admin\\"');
  });

  it('will not open a session with no objective', () => {
    open();
    expect((screen.getByTestId('ask-seed') as HTMLButtonElement).disabled).toBe(true);
  });

  /*
   * The contract is no longer fetched on the way in: the agent is run and its
   * answer comes back. It is fetched only where it is still useful — the
   * fallback, where the person has to carry the question themselves.
   */
  it('shows the contract only when it cannot run the agent for you', async () => {
  (bridge.proposeFromBridge as any).mockImplementation(() => null);
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-agent'));
    fireEvent.change(screen.getByTestId('ask-objective'), { target: { value: 'add SSO' } });
    fireEvent.click(screen.getByTestId('ask-seed'));
    await waitFor(() => screen.getByTestId('ask-copied'));
    expect(screen.getByTestId('ask-contract').textContent).toContain('CONTRACT TEXT');
  });
});

describe('reviewing the answer', () => {
  it('says so when the answer is not JSON, without calling the server', async () => {
    open();
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: 'sure! here you go:' } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => screen.getByTestId('ask-error'));
    expect(api.reviewProposal).not.toHaveBeenCalled();
  });

  it('accepts an answer a model wrapped in a code fence', async () => {
    // The contract forbids the fence. Models produce one anyway, and refusing
    // a correct proposal over its wrapper is friction for nothing.
    open();
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: '```json\n' + answer + '\n```' } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => expect(api.reviewProposal).toHaveBeenCalledTimes(1));
  });

  it('takes a whole terminal scroll, not just clean JSON', async () => {
    // What the agent printed carries prose and a prompt around the object.
    open();
    const scroll = `Three deliverables.\n${answer}\n~/repo $ `;
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: scroll } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => expect(api.reviewProposal).toHaveBeenCalledTimes(1));
  });

  it('reviews on paste, because pasting IS the gesture', async () => {
    open();
    fireEvent.paste(screen.getByTestId('ask-answer'), {
      clipboardData: { getData: () => answer },
    });
    await waitFor(() => expect(api.reviewProposal).toHaveBeenCalledTimes(1));
  });

  it('draws the tree with its nesting', async () => {
    await reviewWith();
    expect(screen.getByTestId('ask-row-e1').style.marginLeft).toBe('0px');
    expect(screen.getByTestId('ask-row-t1').style.marginLeft).toBe('36px');
  });

  it('puts an issue on the row it belongs to', async () => {
    await reviewWith({ ...PROPOSAL, issues: [{ ref: 's1', message: 'no child STORY' }] });
    expect(screen.getByTestId('ask-row-issue-s1').textContent).toBe('no child STORY');
  });
});

describe('the gate', () => {
  it('says nothing has been written, and how many will be', async () => {
    await reviewWith();
    expect(screen.getByTestId('ask-gate').textContent).toMatch(/Nothing has been written/);
    expect(screen.getByTestId('ask-create').textContent).toBe('Create 3 cards');
  });

  it('drops a subtree when its parent is dropped', async () => {
    // Creating t1 without s1 would point a card at a parent id that never
    // existed — worse than either outcome the person chose.
    await reviewWith();
    fireEvent.click(screen.getByTestId('ask-drop-s1'));
    expect(screen.getByTestId('ask-create').textContent).toBe('Create 1 card');
  });

  it('does not count a row that cannot be created', async () => {
    // Saying "Create 3" and creating 2 is a number nobody reconciles later.
    await reviewWith({ ...PROPOSAL, issues: [{ ref: 't1', message: 'title must be a string.' }] });
    expect(screen.getByTestId('ask-create').textContent).toBe('Create 2 cards');
    expect(screen.getByTestId('ask-blocked').textContent).toMatch(/1 row has a problem/);
  });

  // THE PROMISE. If this ever fails, the gate has become a confirmation dialog.
  it('creates nothing until the button is pressed', async () => {
    await reviewWith();
    fireEvent.click(screen.getByTestId('ask-drop-s1'));
    expect(api.createItem).not.toHaveBeenCalled();
  });
});

describe('creating', () => {
  it('creates parents before children, with the real parent id', async () => {
    await reviewWith();
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect(api.createItem).toHaveBeenCalledTimes(3));
    const calls = (api.createItem as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.title)).toEqual(['Port the admin API', 'Move services private', 'terraform port']);
    expect(calls[0].parentId).toBeUndefined();
    expect(calls[1].parentId).toBe('id-Port the admin API');
    expect(calls[2].parentId).toBe('id-Move services private');
  });

  it('skips the rows with problems instead of failing the whole run', async () => {
    await reviewWith({ ...PROPOSAL, issues: [{ ref: 't1', message: 'bad' }] });
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect(api.createItem).toHaveBeenCalledTimes(2));
  });

  it('says how many landed when the server refuses one', async () => {
    // A bare "failed" sends the person hunting for what already exists.
    (api.createItem as any)
      .mockResolvedValueOnce({ id: 'id-1' })
      .mockRejectedValueOnce(new Error('nope'));
    await reviewWith();
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => screen.getByTestId('ask-error'));
    expect(screen.getByTestId('ask-error').textContent).toMatch(/Created 1 of 3/);
  });
});

// ── Running it, instead of handing over a command ──────────────────────────
// This button has been three things: a clipboard copy that drew nothing, and
// then an interactive session whose answer had to be read out of a terminal
// scroll. Both were the long way round a question with one answer and no
// follow-up.
describe('proposing', () => {
  const ask = async (objective = 'add SSO') => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-agent'));
    fireEvent.change(screen.getByTestId('ask-objective'), { target: { value: objective } });
    fireEvent.click(screen.getByTestId('ask-seed'));
  };

  /*
   * The picker is the one the terminal strip already uses — logos and all —
   * rather than a second dropdown grown here. What belongs to THIS file is
   * that it is present and that the panel starts on an installed agent;
   * how it lists and marks an unavailable one is pinned by its own spec.
   */
  it('uses the shared agent picker, starting on one that is installed', async () => {
    render(<AskAgenfk projectId="p1" />);
    const picker = await screen.findByTestId('ask-agent');
    expect(picker.textContent).toContain('Claude Code');
  });

  it('asks the agent, with the project and the objective', async () => {
    await ask('port the admin API');
    await waitFor(() => expect(bridge.proposeFromBridge).toHaveBeenCalledWith({
      projectId: 'p1', agentId: 'claude-code', objective: 'port the admin API',
    }));
  });

  it('reviews what the agent printed, without anyone pasting anything', async () => {
    await ask();
    await waitFor(() => expect(api.reviewProposal).toHaveBeenCalledTimes(1));
  });

  it('locks the answer field while the agent works, and sweeps it', async () => {
    // A spinner in a corner would leave this box looking like an ordinary
    // empty input somebody forgot to type in — and anything typed here
    // meanwhile is overwritten the moment the answer lands.
    let settle: (v: unknown) => void = () => {};
  (bridge.proposeFromBridge as any).mockImplementation(() => new Promise(r => { settle = r; }));
    await ask();
    const field = await screen.findByTestId('ask-answer') as HTMLTextAreaElement;
    await waitFor(() => expect(field.disabled).toBe(true));
    expect(field.className).toContain('agent-sweep');
    expect((screen.getByTestId('ask-review') as HTMLButtonElement).disabled).toBe(true);

    settle({ stdout: JSON.stringify({ objective: 'x', items: [] }) });
    await waitFor(() => expect((screen.getByTestId('ask-answer') as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.getByTestId('ask-answer').className).not.toContain('agent-sweep');
  });

  it('says it is working, because an agent is not fast', async () => {
    let settle: (v: unknown) => void = () => {};
  (bridge.proposeFromBridge as any).mockImplementation(() => new Promise(r => { settle = r; }));
    await ask();
    expect(await screen.findByTestId('ask-running')).toBeDefined();
    settle({ stdout: JSON.stringify({ objective: 'x', items: [] }) });
    await waitFor(() => expect(screen.queryByTestId('ask-running')).toBeNull());
  });

  it('shows the agent’s own reason when it fails', async () => {
    // Not logged in, rate limited, model unavailable — the CLI knows, and the
    // screen used to swallow it and offer a copy instead.
    // `mockImplementation`, not `mockReturnValue`: the latter builds the
    // rejected promise at SETUP time, so it sits unhandled until the component
    // gets round to awaiting it and the run reports an unhandled rejection.
  (bridge.proposeFromBridge as any).mockImplementation(
      () => Promise.reject(new Error('Invalid API key — run `claude login`')),
    );
    await ask();
    await waitFor(() => screen.getByTestId('ask-error'));
    expect(screen.getByTestId('ask-error').textContent).toContain('claude login');
  });

  it('falls back to the clipboard only when the build cannot run anything', async () => {
  (bridge.proposeFromBridge as any).mockImplementation(() => null);
    await ask();
    await waitFor(() => screen.getByTestId('ask-error'));
    expect(screen.getByTestId('ask-error').textContent).toMatch(/predates|browser/);
    expect(screen.getByTestId('ask-copied')).toBeDefined();
  });
});

// ── Where the cards land ───────────────────────────────────────────────────
// The panel is opened from a terminal or a board that implies a project, and
// that used to be the whole decision — invisible. "Where did my cards go" is
// not a question a person should answer by looking at the board afterwards,
// and the same project is also where the agent runs.
describe('the destination project', () => {
  it('starts on the one the panel was opened for', async () => {
    render(<AskAgenfk projectId="p1" />);
    // The closed control names the project rather than carrying its id: a
    // native select showed neither the folder nor the path.
    await waitFor(() => expect(screen.getByTestId('ask-project').textContent).toContain('agenfk'));
  });

  it('runs the agent in the project that is chosen, not the one passed in', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project-option-p2'));
    fireEvent.change(screen.getByTestId('ask-objective'), { target: { value: 'add SSO' } });
    fireEvent.click(screen.getByTestId('ask-seed'));
    await waitFor(() => expect(bridge.proposeFromBridge).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p2' }),
    ));
  });

  it('creates the cards in the chosen project too', async () => {
    (api.reviewProposal as any).mockResolvedValue({
      objective: 'x',
      items: [{ ref: 'a', type: 'TASK', title: 'One', parentRef: null, depth: 0 }],
      issues: [],
    });
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project-option-p2'));
    fireEvent.change(screen.getByTestId('ask-objective'), { target: { value: 'add SSO' } });
    fireEvent.click(screen.getByTestId('ask-seed'));
    await waitFor(() => screen.getByTestId('ask-create'));
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect(api.createItem).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p2' }),
    ));
  });

  it('refuses a project with no folder, because an agent needs somewhere to run', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    const option = screen.getByTestId('ask-project-option-p3');
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toMatch(/nowhere to run/i);
  });
});

// ── Getting out ────────────────────────────────────────────────────────────
describe('closing the panel', () => {
  it('has an X, not just a backdrop you have to know about', async () => {
    const onClose = vi.fn();
    render(<AskAgenfk projectId="p1" onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('ask-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape, which is the gesture people try first', async () => {
    const onClose = vi.fn();
    render(<AskAgenfk projectId="p1" onClose={onClose} />);
    await screen.findByTestId('ask-agenfk');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ── The way out of "I have no project for this yet" ────────────────────────
// Every other door in this panel assumes the project exists. This one was the
// dead end the user found: an objective, and nowhere to put the cards. The
// three ways in now live in their own dialog (AddProjectDialog.test.tsx); what
// belongs HERE is only that the door opens and that whatever it produces
// becomes the selected project.
describe('the way in when there is no project yet', () => {
  it('opens the dialog rather than adding anything itself', async () => {
    render(<AskAgenfk projectId="p1" />);
    expect(screen.queryByTestId('add-project')).toBeNull();
    fireEvent.click(await screen.findByTestId('ask-add-project'));
    await waitFor(() => screen.getByTestId('add-project'));
  });

  it('selects the project the dialog produced, and shows its path', async () => {
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ path: '/checkout/horizon-ds', name: 'horizon-ds' }),
    );
    (bridge.addChosenFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }),
    );
    (api.listProjects as any)
      .mockResolvedValueOnce([{ id: 'p1', name: 'agenfk', projectRoot: '/checkout/agenfk' }])
      .mockResolvedValueOnce([
        { id: 'p1', name: 'agenfk', projectRoot: '/checkout/agenfk' },
        { id: 'p9', name: 'horizon-ds', projectRoot: '/checkout/horizon-ds' },
      ]);

    render(<AskAgenfk projectId="p1" />);
    fireEvent.click(await screen.findByTestId('ask-add-project'));
    fireEvent.click(await screen.findByTestId('add-project-choose-folder'));
    // Two steps now: the picker fills the fields, the button writes.
    await waitFor(() => screen.getByTestId('add-project-name-from'));
    fireEvent.click(screen.getByTestId('add-project-add'));
    await waitFor(() => expect(screen.getByTestId('ask-project').textContent).toContain('horizon-ds'));
    expect(screen.getByTestId('ask-project-root').textContent).toBe('/checkout/horizon-ds');
    // And the dialog closed: it did its one job.
    expect(screen.queryByTestId('add-project')).toBeNull();
  });
});

// ── The path that needs no agent ───────────────────────────────────────────
// Proposing needs an agent installed, authenticated and answering. It is now
// the only door on the project page, so the hand-written path had to survive
// somewhere — inside, next to the place the panel already explains itself when
// it cannot reach one.
describe('writing the card yourself', () => {
  it('offers the way out, with the project that is selected', async () => {
    const onWriteByHand = vi.fn();
    render(<AskAgenfk projectId="p1" onWriteByHand={onWriteByHand} />);
    fireEvent.click(await screen.findByTestId('ask-by-hand'));
    expect(onWriteByHand).toHaveBeenCalledWith('p1');
  });

  it('hands over the project the person chose, not the one passed in', async () => {
    const onWriteByHand = vi.fn();
    render(<AskAgenfk projectId="p1" onWriteByHand={onWriteByHand} />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project-option-p2'));
    fireEvent.click(screen.getByTestId('ask-by-hand'));
    expect(onWriteByHand).toHaveBeenCalledWith('p2');
  });

  it('is absent when the host has nowhere to send them', async () => {
    // A control that calls nothing is the dead button this panel has already
    // been twice.
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    expect(screen.queryByTestId('ask-by-hand')).toBeNull();
  });
});

// ── Watching the run, not just waiting for it ──────────────────────────────
// "The agent is working on it" cannot distinguish thinking from wedged from a
// CLI that is out of quota and saying so on a stream nobody displays. Any
// agent can end a run that way, which is why this is generic.
describe('what the agent is printing', () => {
  const emit = (): ((e: { stream: 'stdout' | 'stderr'; line: string }) => void) =>
    (bridge.onProposeOutputFromBridge as any).mock.calls[0][0];

  it('subscribes while the panel is open, and unsubscribes when it closes', async () => {
    const off = vi.fn();
    (bridge.onProposeOutputFromBridge as any).mockImplementation(() => off);
    const { unmount } = render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    unmount();
    expect(off).toHaveBeenCalled();
  });

  it('shows the lines as they arrive', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    emit()({ stream: 'stdout', line: 'thinking about the objective' });
    await waitFor(() => screen.getByTestId('ask-output'));
    expect(screen.getByTestId('ask-output').textContent).toContain('thinking about the objective');
  });

  it('marks stderr apart, because that is where "out of tokens" arrives', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    emit()({ stream: 'stderr', line: 'Error: usage limit reached for this account' });
    await waitFor(() => screen.getByTestId('ask-output-stderr'));
    expect(screen.getByTestId('ask-output-stderr').textContent).toContain('usage limit reached');
  });

  it('keeps a tail rather than the whole transcript', async () => {
    // A chatty agent over a long run is otherwise an unbounded array with a
    // scrollbar.
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    const send = emit();
    for (let i = 0; i < 260; i++) send({ stream: 'stdout', line: `line ${i}` });
    await waitFor(() => screen.getByTestId('ask-output'));
    expect(screen.getByTestId('ask-output').textContent).not.toContain('line 0 ');
    expect(screen.getByTestId('ask-output').textContent).toContain('line 259');
  });

  it('says nothing at all before a run prints anything', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    expect(screen.queryByTestId('ask-output')).toBeNull();
  });
});

describe('changing the project', () => {
  it('moves the path beside the picker too, not just the name in it', async () => {
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-project'));
    expect(screen.getByTestId('ask-project-root').textContent).toBe('/checkout/agenfk');
    fireEvent.click(screen.getByTestId('ask-project'));
    /*
     * THE WHOLE GESTURE, not just the click. A real pointer sends
     * mousedown → mouseup → click, and the defect this pins lived in the
     * first: the menu closed on the way down, so the click landed on nothing.
     * `fireEvent.click` alone passed with the bug present.
     */
    const option = screen.getByTestId('ask-project-option-p2');
    fireEvent.mouseDown(option);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
    await waitFor(() => expect(screen.getByTestId('ask-project').textContent).toContain('horizon-lab'));
    expect(screen.getByTestId('ask-project-root').textContent).toBe('/checkout/horizon');
  });
});

// ── Landing on the result ──────────────────────────────────────────────────
// Both doors used to end by closing the panel onto the screen the person
// started from, with the thing they just made somewhere else.
describe('after something is created', () => {
  it('hands back the project the cards actually landed in, not the one it opened with', async () => {
    // The panel lets the project be changed after it opened, so the caller's
    // idea of where this was for can be stale by the time anything exists.
    const onCreated = vi.fn();
    (api.createItem as any).mockImplementation(async (i: any) => ({ id: `id-${i.title}` }));
    render(<AskAgenfk projectId="p1" onCreated={onCreated} />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    const option = screen.getByTestId('ask-project-option-p2');
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: answer } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => screen.getByTestId('ask-create'));
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(3, 'p2'));
  });

  it('reports a project added from inside, so the caller can go to it', async () => {
    const onProjectAdded = vi.fn();
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ path: '/checkout/horizon-ds', name: 'horizon-ds' }),
    );
    (bridge.addChosenFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }),
    );
    render(<AskAgenfk projectId="p1" onProjectAdded={onProjectAdded} />);
    fireEvent.click(await screen.findByTestId('ask-add-project'));
    fireEvent.click(await screen.findByTestId('add-project-choose-folder'));
    await waitFor(() => screen.getByTestId('add-project-name-from'));
    fireEvent.click(screen.getByTestId('add-project-add'));
    await waitFor(() => expect(onProjectAdded).toHaveBeenCalledWith('p9'));
  });
});


/*
 * Everything below was found by an adversarial review of 85b807dd, and every
 * one of them was a behaviour the existing tests had no opinion about.
 */
describe('the panel keeps its promises while it writes', () => {
  const blockedProposal = {
    objective: 'port the admin API',
    contractVersion: 1,
    items: [
      { ref: 'e1', type: 'EPIC', title: 'Port the admin API', parentRef: null, depth: 0 },
      { ref: 's1', type: 'STORY', title: '', parentRef: 'e1', depth: 1 },
      { ref: 't1', type: 'TASK', title: 'terraform', parentRef: 's1', depth: 2 },
      { ref: 't2', type: 'TASK', title: 'dashboards', parentRef: 's1', depth: 2 },
    ],
    // The issue sits on the PARENT, which is the case the old fixture avoided.
    issues: [{ ref: 's1', message: 'This item has no title.' }],
  };

  const reviewWith = async (proposal: unknown) => {
    (api.reviewProposal as any).mockResolvedValue(proposal);
    render(<AskAgenfk projectId="p1" />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: answer } });
    fireEvent.click(screen.getByTestId('ask-review'));
    return waitFor(() => screen.getByTestId('ask-create'));
  };

  it('never creates the children of a row it is skipping', async () => {
    // They were POSTed with no parentId, which is a TOP-LEVEL card: a story
    // with no title turned its two tasks into two loose cards on the board.
    //
    // Waited on the END of the loop, not on a count: `waitFor` with
    // toHaveBeenCalledTimes(1) is satisfied by the FIRST call and returns
    // while the rest are still being written — which is how this very test
    // passed against the defect it was written for.
    const onCreated = vi.fn();
    (api.reviewProposal as any).mockResolvedValue(blockedProposal);
    render(<AskAgenfk projectId="p1" onCreated={onCreated} />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: answer } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => screen.getByTestId('ask-create'));
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createItem).toHaveBeenCalledTimes(1);
    expect((api.createItem as any).mock.calls[0][0].title).toBe('Port the admin API');
  });

  it('counts on the button exactly what it will write', async () => {
    await reviewWith(blockedProposal);
    expect(screen.getByTestId('ask-create').textContent).toMatch(/create 1 card/i);
  });

  it('cannot be dismissed while it is writing, because dismissing does not stop it', async () => {
    // create() is a loop of POSTs with no way back. Cancel used to close the
    // panel and let the loop finish, then navigate to the cards the person
    // had just refused.
    let release: (v: unknown) => void = () => {};
    (api.createItem as any).mockImplementation(() => new Promise(r => { release = r; }));
    await reviewWith(PROPOSAL);
    fireEvent.click(screen.getByTestId('ask-create'));
    await waitFor(() => expect((screen.getByTestId('ask-cancel') as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId('ask-close') as HTMLButtonElement).disabled).toBe(true);
    release({ id: 'x' });
  });

  it('keeps a reviewed proposal when a project is added from inside', async () => {
    // Navigating away closes this panel. Somebody who realises mid-review that
    // the cards belong in a new project would lose the objective, the answer
    // and every keep/drop decision to the act of creating it.
    const onProjectAdded = vi.fn();
    (bridge.chooseProjectFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ path: '/checkout/horizon-ds', name: 'horizon-ds' }),
    );
    (bridge.addChosenFolderFromBridge as any).mockImplementation(
      () => Promise.resolve({ id: 'p9', name: 'horizon-ds' }),
    );
    (api.reviewProposal as any).mockResolvedValue(PROPOSAL);
    // The refreshed list has to contain the new project, or the picker has
    // nothing to name and the assertion below tests the fixture, not the code.
    (api.listProjects as any).mockResolvedValue([
      { id: 'p1', name: 'agenfk', projectRoot: '/checkout/agenfk' },
      { id: 'p9', name: 'horizon-ds', projectRoot: '/checkout/horizon-ds' },
    ]);
    render(<AskAgenfk projectId="p1" onProjectAdded={onProjectAdded} />);
    await waitFor(() => screen.getByTestId('ask-objective'));
    fireEvent.change(screen.getByTestId('ask-answer'), { target: { value: answer } });
    fireEvent.click(screen.getByTestId('ask-review'));
    await waitFor(() => screen.getByTestId('ask-create'));

    fireEvent.click(screen.getByTestId('ask-add-project'));
    fireEvent.click(await screen.findByTestId('add-project-choose-folder'));
    await waitFor(() => screen.getByTestId('add-project-name-from'));
    fireEvent.click(screen.getByTestId('add-project-add'));

    await waitFor(() => expect(screen.getByTestId('ask-project').textContent).toContain('horizon-ds'));
    // Still here, with the tree intact.
    expect(screen.getByTestId('ask-create')).toBeTruthy();
    expect(onProjectAdded).not.toHaveBeenCalled();
  });
});

describe('Escape with a dropdown open', () => {
  it('closes the dropdown and leaves the panel standing', async () => {
    // The panel listens on the same document node. Without stopping the key,
    // dismissing a menu threw away the objective and the reviewed tree.
    const onClose = vi.fn();
    render(<AskAgenfk projectId="p1" onClose={onClose} />);
    await waitFor(() => screen.getByTestId('ask-project'));
    fireEvent.click(screen.getByTestId('ask-project'));
    await waitFor(() => screen.getByTestId('ask-project-options'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('ask-project-options')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});
