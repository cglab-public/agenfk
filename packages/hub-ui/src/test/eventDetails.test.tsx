/**
 * @vitest-environment jsdom
 *
 * Readable user-page events (story ce9b0e8e). A badge reads as words; an
 * expanded event shows the fields that matter as a label/value list, with PRs
 * and tracker keys linked where the hub knows where they live, and the raw JSON
 * one toggle away instead of in your face.
 */
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { eventFields } from '../eventDetails';
import { eventTone } from '../eventTone';
import { UserDetailPage } from '../pages/UserDetail';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { cleanup(); get.mockReset(); });

const base = {
  occurred_at: '2026-09-01T10:00:00.000Z', project_id: 'p1', item_id: 'i-42', item_type: 'TASK',
  remote_url: 'git@github.com:acme/api.git', item_title: 'Fix the picker', external_id: null,
  user_key: 'alice@acme.com', reporting_version: '2.0.0', pr_url: null,
};
const row = (event_id: string, type: string, inner: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ ...base, event_id, type, payload: { type, payload: inner }, ...over });

const EVENTS = [
  row('pr', 'pr.opened', { prNumber: 7, repo: 'acme/api', model: 'claude-opus-5-5', harness: 'claude-code', sizing: { epic: 0, story: 1, task: 2, bug: 0 } },
    { pr_url: 'https://github.com/acme/api/pull/7' }),
  row('step', 'step.transitioned', { fromStatus: 'REVIEW', toStatus: 'DONE', itemType: 'TASK' }, { external_id: 'CGLAB-163' }),
  // The spoke sends the tracker URL beside the key, at the event's top level.
  { ...row('jira', 'item.created', { title: 'Fix the picker', itemType: 'TASK', customNote: 'hello' }, { external_id: 'CGLAB-9' }),
    payload: { type: 'item.created', externalUrl: 'https://cg-lab.atlassian.net/browse/CGLAB-9', payload: { title: 'Fix the picker', itemType: 'TASK', customNote: 'hello', flow: { name: 'TDD Flow', install_source: 'manual' } } } },
  // As the gate emits it.
  row('fail', 'validate.failed', { fromStatus: 'IN_PROGRESS', stayedOn: 'IN_PROGRESS', command: null, checks: [
    { id: 'on-card-branch', outcome: 'pass', blocking: true },
    { id: 'test-count-not-lower', outcome: 'fail', blocking: true },
    { id: 'coverage', outcome: 'unavailable', blocking: false },
    { id: 'new-tests-born-green', outcome: 'unavailable', blocking: true },
    { id: 'lint-advice', outcome: 'fail', blocking: false },
  ] }),
];

describe('eventFields', () => {
  it('turns a PR event into labelled fields with a link', () => {
    const f = eventFields(EVENTS[0] as any);
    expect(f).toContainEqual({ label: 'Pull request', value: 'acme/api #7', href: 'https://github.com/acme/api/pull/7' });
    expect(f).toContainEqual({ label: 'Model', value: 'claude-opus-5-5' });
    expect(f).toContainEqual({ label: 'Harness', value: 'claude-code' });
    expect(f).toContainEqual({ label: 'Size', value: '1 story · 2 tasks' });
    expect(f).toContainEqual({ label: 'Item', value: 'Fix the picker (i-42)' });
  });

  it('shows a step change as from → to', () => {
    expect(eventFields(EVENTS[1] as any)).toContainEqual({ label: 'Step', value: 'REVIEW → DONE' });
  });

  it('links a tracker key only when the event says where it lives', () => {
    expect(eventFields(EVENTS[1] as any)).toContainEqual({ label: 'Tracker', value: 'CGLAB-163' });
    expect(eventFields(EVENTS[2] as any)).toContainEqual({ label: 'Tracker', value: 'CGLAB-9', href: 'https://cg-lab.atlassian.net/browse/CGLAB-9' });
    // https only: a plain-http URL from an untrusted payload is not linked.
    const http = { ...EVENTS[2], payload: { ...EVENTS[2].payload, externalUrl: 'http://cg-lab.atlassian.net/browse/CGLAB-9' } };
    expect(eventFields(http as any)).toContainEqual({ label: 'Tracker', value: 'CGLAB-9' });
  });

  it('never links a non-http URL', () => {
    const f = eventFields({ ...row('x', 'item.created', {}, { external_id: 'K-1' }), payload: { externalUrl: 'javascript:alert(1)', payload: {} } } as any);
    expect(f).toContainEqual({ label: 'Tracker', value: 'K-1' });
  });

  it('keeps other scalar fields, with readable labels, but not ones the row already shows', () => {
    const f = eventFields(EVENTS[2] as any);
    expect(f).toContainEqual({ label: 'Custom note', value: 'hello' });
    expect(f).toContainEqual({ label: 'Flow', value: 'TDD Flow' });
    expect(f.map(x => x.label)).not.toContain('Title');
    expect(f.map(x => x.label)).not.toContain('Item type');
  });

  it('names the checks that failed, and the step it stayed on', () => {
    const f = eventFields(EVENTS[3] as any);
    expect(f).toContainEqual({ label: 'Failed checks', value: 'test-count-not-lower' });
    // Only checks that block the move: a soft one did not cause the refusal.
    expect(f).toContainEqual({ label: 'Not run', value: 'new-tests-born-green' });
    expect(f).toContainEqual({ label: 'Stayed on', value: 'IN_PROGRESS' });
    expect(f.map(x => x.label)).not.toContain('Step');
  });

  it('says where a check ran when there is no destination', () => {
    expect(eventFields(row('v', 'validate.invoked', { fromStatus: 'REVIEW' }) as any)).toContainEqual({ label: 'At step', value: 'REVIEW' });
  });

  it('shows what changed on an update and what command was approved', () => {
    expect(eventFields(row('u', 'item.updated', { changedFields: ['title', 'status'] }) as any))
      .toContainEqual({ label: 'Changed', value: 'title, status' });
    expect(eventFields(row('c', 'command.approved', { hash: 'abc', argv: ['npm', 'test'], by: 'board' }) as any))
      .toContainEqual({ label: 'Command', value: 'npm test' });
  });

  it('caps a long text field', () => {
    const long = 'x'.repeat(2000);
    const f = eventFields(row('m', 'comment.added', { content: long }) as any).find(x => x.label === 'Content')!;
    expect(f.value.length).toBeLessThanOrEqual(501);
    expect(f.value.endsWith('…')).toBe(true);
  });
});

describe('eventTone', () => {
  it('reads PRs as lifecycle and approvals as a pass', () => {
    expect(eventTone('pr.opened')).toBe('accent');
    expect(eventTone('pr.updated')).toBe('accent');
    expect(eventTone('step.approved')).toBe('ok');
  });
});

describe('the user page event list', () => {
  beforeEach(() => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/timeline')) return { data: { events: EVENTS, total: EVENTS.length } };
      if (url.startsWith('/v1/event-types')) return { data: { types: [] } };
      if (url.startsWith('/v1/projects')) return { data: { projects: [] } };
      if (url.startsWith('/v1/item-types')) return { data: { itemTypes: [], counts: {} } };
      if (url.startsWith('/v1/metrics')) return { data: { bucket: 'day', series: [] } };
      if (url.startsWith('/v1/histogram')) return { data: { bucket: 'day', buckets: [] } };
      return { data: {} };
    });
  });
  const mount = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/users/alice%40acme.com?types=']}>
          <Routes><Route path="/users/:userKey" element={<UserDetailPage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('labels badges in words, raw id on hover', async () => {
    mount();
    const badge = await screen.findByText('PR opened');
    expect(badge).toHaveAttribute('title', 'pr.opened');
    // In the event list (the filter chips use the same words).
    const inList = screen.getAllByText('Step changed').filter(el => el.closest('summary'));
    expect(inList).toHaveLength(1);
    expect(inList[0]).toHaveAttribute('title', 'step.transitioned');
    // The raw id is not on the row itself; opening the event shows it as Type.
    const raw = screen.getAllByText('step.transitioned');
    expect(raw.filter(el => el.closest('summary'))).toHaveLength(0);
    expect(raw.some(el => el.previousElementSibling?.textContent === 'Type')).toBe(true);
  });

  it('opens to a field list with links, and keeps the raw JSON behind a toggle', async () => {
    mount();
    const summary = (await screen.findByText('PR opened')).closest('summary') as HTMLElement;
    fireEvent.click(summary);
    const details = summary.parentElement as HTMLElement;
    const pr = within(details).getByRole('link', { name: /^acme\/api #7\s*\(opens in a new tab\)$/ });
    expect(pr).toHaveAttribute('href', 'https://github.com/acme/api/pull/7');
    expect(pr).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The destination is visible on hover, not hidden behind the key text.
    expect(pr).toHaveAttribute('title', 'https://github.com/acme/api/pull/7');
    expect(within(details).getByText('Model').nextElementSibling).toHaveTextContent('claude-opus-5-5');
    expect(details.querySelector('pre')).toBeNull();
    // Several events can be open at once: each toggle names its own event.
    const toggle = within(details).getByRole('button', { name: /^Show raw JSON for PR opened\b/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(details).getByRole('button', { name: /^Hide raw JSON for PR opened\b/ })).toHaveAttribute('aria-expanded', 'true');
    expect(details.querySelector('pre')).toHaveTextContent('"prNumber": 7');
  });
});
