/**
 * @vitest-environment jsdom
 *
 * Which project this is for.
 *
 * It was a native `<select>`, and inside a dark window the operating system
 * drew it as a white system menu in the system font — ignoring every token the
 * rest of the app is built from. A native menu also cannot carry the folder or
 * the path, and the path is what answers "which agenfk" on a machine holding
 * three checkouts of it.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProjectPicker } from '../components/ProjectPicker';

afterEach(() => cleanup());

const projects = [
  { id: 'p1', name: 'agenfk', projectRoot: '/Users/me/GitHub/agenfk' },
  { id: 'p2', name: 'horizon-lab', projectRoot: '/Users/me/GitHub/horizon-lab' },
  { id: 'p3', name: 'abc' },
];

const open = (onChange = vi.fn()) => {
  render(<ProjectPicker value="p1" projects={projects} onChange={onChange} />);
  fireEvent.click(screen.getByTestId('project-picker'));
  return onChange;
};

it('shows the chosen project, closed', () => {
  render(<ProjectPicker value="p1" projects={projects} onChange={vi.fn()} />);
  expect(screen.getByTestId('project-picker').textContent).toContain('agenfk');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('shows every project with the folder it lives in', () => {
  open();
  expect(screen.getByTestId('project-picker-option-p2').textContent).toContain('/Users/me/GitHub/horizon-lab');
});

it('marks the current one', () => {
  open();
  expect(screen.getByTestId('project-picker-option-p1').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByTestId('project-picker-option-p2').getAttribute('aria-selected')).toBe('false');
});

it('reports a choice and closes', () => {
  const onChange = open();
  fireEvent.click(screen.getByTestId('project-picker-option-p2'));
  expect(onChange).toHaveBeenCalledWith('p2');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('offers a project with no folder as unavailable, rather than hiding it', () => {
  // Hiding it turns "not set up yet" into "does not exist".
  const onChange = open();
  const option = screen.getByTestId('project-picker-option-p3');
  expect(option.getAttribute('aria-disabled')).toBe('true');
  expect(option.textContent).toMatch(/nowhere to run/i);
  fireEvent.click(option);
  expect(onChange).not.toHaveBeenCalled();
});

it('escapes its container, because a panel scrolls', () => {
  // Absolutely positioned inside its own wrapper it was clipped by the first
  // scrolling ancestor — which in a panel is the panel.
  open();
  const menu = screen.getByRole('listbox');
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.position).toBe('fixed');
});

it('closes on Escape', () => {
  open();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

/*
 * Dismissal, and the half of it that was wrong.
 *
 * The menu closed on any `mousedown` outside the BUTTON — and since the menu
 * is a portal, that included every one of its own options. React unmounted the
 * option between mousedown and mouseup, so the click never completed on it and
 * choosing a project did nothing at all, silently. Every existing test passed,
 * because `fireEvent.click` sends only the click.
 */
describe('pressing the mouse', () => {
  const projects = [
    { id: 'p1', name: 'agenfk', projectRoot: '/checkout/agenfk' },
    { id: 'p2', name: 'horizon-lab', projectRoot: '/checkout/horizon' },
  ];

  it('chooses the project when the whole gesture lands on an option', () => {
    const onChange = vi.fn();
    render(<ProjectPicker value="p1" projects={projects} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('project-picker'));
    const option = screen.getByTestId('project-picker-option-p2');
    fireEvent.mouseDown(option);
    fireEvent.mouseUp(option);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('p2');
  });

  it('does not dismiss on a press inside its own list', () => {
    render(<ProjectPicker value="p1" projects={projects} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('project-picker'));
    fireEvent.mouseDown(screen.getByTestId('project-picker-option-p2'));
    expect(screen.getByTestId('project-picker-options')).toBeTruthy();
  });

  it('still dismisses on a press that is genuinely outside', () => {
    // The guard it replaces is still doing its job.
    render(<ProjectPicker value="p1" projects={projects} onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('project-picker'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('project-picker-options')).toBeNull();
  });
});
