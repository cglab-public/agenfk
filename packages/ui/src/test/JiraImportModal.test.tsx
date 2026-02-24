/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { JiraImportModal } from '../components/JiraImportModal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    listJiraProjects: vi.fn(),
    listJiraIssues: vi.fn(),
    importJiraIssues: vi.fn(),
  },
}));

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );

const PROJECTS = [
  { id: 'p1', key: 'PROJ', name: 'Project One' },
  { id: 'p2', key: 'FOO', name: 'Foo Project' },
];

const ISSUES = [
  { id: 'i1', key: 'PROJ-1', summary: 'Epic issue', issueType: 'Epic', status: 'To Do' },
  { id: 'i2', key: 'PROJ-2', summary: 'Story issue', issueType: 'Story', status: 'In Progress' },
  { id: 'i3', key: 'PROJ-3', summary: 'Bug issue', issueType: 'Bug', status: 'To Do' },
  { id: 'i4', key: 'PROJ-4', summary: 'Task issue', issueType: 'Task', status: 'Done' },
];

describe('JiraImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when open=false', () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    render(
      <JiraImportModal open={false} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );
    expect(screen.queryByTestId('jira-import-modal')).toBeNull();
  });

  it('renders project list when open', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    const list = await screen.findByTestId('project-list');
    expect(list).toBeDefined();
    expect(screen.getByTestId('project-item-PROJ')).toBeDefined();
    expect(screen.getByTestId('project-item-FOO')).toBeDefined();
  });

  it('shows error state with retry button on project fetch failure', async () => {
    vi.mocked(api.listJiraProjects).mockRejectedValue(new Error('Network Error'));
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    const errorEl = await screen.findByTestId('projects-error');
    expect(errorEl).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('navigates to issue list on project click', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    const projBtn = await screen.findByTestId('project-item-PROJ');
    fireEvent.click(projBtn);

    const issueList = await screen.findByTestId('issue-list');
    expect(issueList).toBeDefined();
    expect(api.listJiraIssues).toHaveBeenCalledWith('PROJ', expect.objectContaining({
      statusCategory: 'To Do,In Progress'
    }));
  });

  it('renders issue list with correct AgenFK type selects', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    expect((screen.getByTestId('type-select-PROJ-1') as HTMLSelectElement).value).toBe('EPIC');
    expect((screen.getByTestId('type-select-PROJ-2') as HTMLSelectElement).value).toBe('STORY');
    expect((screen.getByTestId('type-select-PROJ-3') as HTMLSelectElement).value).toBe('BUG');
    expect((screen.getByTestId('type-select-PROJ-4') as HTMLSelectElement).value).toBe('TASK');
  });

  it('allows changing issue type before import', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    const checkbox = screen.getByTestId('issue-item-PROJ-4').querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);

    const select = screen.getByTestId('type-select-PROJ-4') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'BUG' } });
    expect(select.value).toBe('BUG');

    fireEvent.click(screen.getByTestId('next-to-confirm'));
    await screen.findByTestId('confirm-import');

    expect(screen.getByTestId('confirm-summary').textContent).toContain('1');
    expect(screen.getByText('PROJ-4')).toBeDefined();
    expect(screen.getByText('BUG')).toBeDefined();
  });

  it('selects issues and advances to confirm step', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    const checkbox1 = screen.getByTestId('issue-item-PROJ-1').querySelector('input[type="checkbox"]')!;
    const checkbox2 = screen.getByTestId('issue-item-PROJ-2').querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox1);
    fireEvent.click(checkbox2);

    const nextBtn = screen.getByTestId('next-to-confirm');
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(nextBtn);

    await waitFor(() => expect(screen.getByTestId('confirm-import')).toBeDefined());
    expect(screen.getByTestId('confirm-summary').textContent).toContain('2');
  });

  it('calls importJiraIssues with selected keys on confirm', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    vi.mocked(api.importJiraIssues).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <JiraImportModal open={true} onClose={onClose} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    const checkbox = screen.getByTestId('issue-item-PROJ-3').querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('next-to-confirm'));

    await waitFor(() => screen.getByTestId('confirm-import'));
    fireEvent.click(screen.getByTestId('confirm-import'));

    await waitFor(() =>
      expect(api.importJiraIssues).toHaveBeenCalledWith('proj-1', [{ issueKey: 'PROJ-3', type: 'BUG' }])
    );
    await waitFor(() => expect(screen.getByTestId('import-success')).toBeDefined());
  });

  it('shows error on import failure', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    vi.mocked(api.importJiraIssues).mockRejectedValue(new Error('Import failed'));
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    const checkbox = screen.getByTestId('issue-item-PROJ-1').querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('next-to-confirm'));

    await waitFor(() => screen.getByTestId('confirm-import'));
    fireEvent.click(screen.getByTestId('confirm-import'));

    await waitFor(() => expect(screen.getByTestId('import-error')).toBeDefined());
  });

  it('Next button disabled when no issues selected', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    vi.mocked(api.listJiraIssues).mockResolvedValue(ISSUES);
    render(
      <JiraImportModal open={true} onClose={() => {}} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    fireEvent.click(await screen.findByTestId('project-item-PROJ'));
    await screen.findByTestId('issue-list');

    const nextBtn = await screen.findByTestId('next-to-confirm');
    expect((nextBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('close button calls onClose', async () => {
    vi.mocked(api.listJiraProjects).mockResolvedValue(PROJECTS);
    const onClose = vi.fn();
    render(
      <JiraImportModal open={true} onClose={onClose} projectId="proj-1" />,
      { wrapper: wrapper(makeQueryClient()) }
    );

    await screen.findByTestId('jira-import-modal');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
