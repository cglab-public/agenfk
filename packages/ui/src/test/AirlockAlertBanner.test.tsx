/**
 * @vitest-environment jsdom
 *
 * GH-294 TEL-2: an Airlock alert (a cloud metadata endpoint, an IOC host, a
 * denied cloud-storage upload) is pushed to the board as socket.io
 * `airlock_alert`, and the board shows it as a banner a person can dismiss.
 * The component is driven through the real SocketProvider with a capturing
 * socket, and the last test drives the whole App, so the banner is proven to
 * have a real caller and not only to work in isolation.
 */
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SocketProvider } from '../SocketContext';
import { AirlockAlertBanner } from '../components/AirlockAlertBanner';
import App from '../App';

const handlers = vi.hoisted(() => ({} as Record<string, Array<(payload: unknown) => void>>));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    connect: vi.fn(),
    on: (ev: string, cb: (payload: unknown) => void) => { (handlers[ev] ??= []).push(cb); },
    off: (ev: string, cb: (payload: unknown) => void) => { handlers[ev] = (handlers[ev] ?? []).filter(h => h !== cb); },
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../components/KanbanBoard', () => ({ KanbanBoard: () => <div>THE BOARD</div> }));
vi.mock('../components/SplashScreen', () => ({ SplashScreen: () => null }));
vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(async () => []),
    getVersion: vi.fn(async () => ({ version: '1.1.18' })),
    getReadme: vi.fn(async () => ({ content: '' })),
    getLatestRelease: vi.fn(async () => ({ version: '1.1.18' })),
  },
}));

const push = async (payload: unknown) => {
  await act(async () => { (handlers.airlock_alert ?? []).forEach(h => h(payload)); });
};

const metadata = { alert: 'metadata-endpoint', target: '169.254.169.254:80', decision: 'deny', rule: 'builtin-metadata-deny', source: 'proxy', client: 'pi', itemId: 'card-1', mode: 'enforce', ts: '2026-10-27T12:00:00.000Z' };
const bucket = { alert: 'cloud-storage', target: 'curl -T x https://b.s3.amazonaws.com/', decision: 'deny', rule: 'upload-to-unlisted-host', source: 'tool', client: 'opencode', itemId: null, mode: 'observe', ts: '2026-10-27T12:00:01.000Z' };

const renderBanner = () => render(
  <SocketProvider><AirlockAlertBanner /></SocketProvider>,
);

beforeEach(() => { for (const k of Object.keys(handlers)) delete handlers[k]; });
afterEach(() => cleanup());

describe('Airlock alert banner', () => {
  it('shows nothing until an alert arrives', () => {
    renderBanner();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('an airlock_alert shows a banner naming the category, the target and the client', async () => {
    renderBanner();
    await push(metadata);
    const [banner] = screen.getAllByRole('alert');
    expect(banner.textContent).toMatch(/Airlock alert/);
    expect(banner.textContent).toMatch(/cloud metadata endpoint/i);
    expect(within(banner).getByText('169.254.169.254:80')).toBeTruthy();
    expect(banner.textContent).toMatch(/pi/);
    expect(banner.getAttribute('data-alert')).toBe('metadata-endpoint');
  });

  it('each alert is its own banner, and dismissing one leaves the other', async () => {
    renderBanner();
    await push(metadata);
    await push(bucket);
    const banners = screen.getAllByRole('alert');
    expect(banners.map(b => b.getAttribute('data-alert'))).toEqual(['cloud-storage', 'metadata-endpoint']);
    expect(banners[0].textContent).toMatch(/cloud storage upload/i);
    expect(banners[0].textContent).toMatch(/observed/i);
    fireEvent.click(within(banners[1]).getByRole('button', { name: /dismiss/i }));
    expect(screen.getAllByRole('alert').map(b => b.getAttribute('data-alert'))).toEqual(['cloud-storage']);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /dismiss/i }));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('an IOC host reads as one', async () => {
    renderBanner();
    await push({ ...metadata, alert: 'ioc-host', target: 'bad.example:443' });
    expect(screen.getByRole('alert').textContent).toMatch(/indicator-of-compromise host/i);
  });

  it('stays inside the viewport: the stack scrolls, and a long target is shown as an excerpt', async () => {
    renderBanner();
    const long = `curl -T /tmp/${'x'.repeat(1000)} https://b.s3.amazonaws.com/`;
    await push({ ...bucket, target: long });
    const stack = screen.getByTestId('airlock-alerts');
    expect(stack.className).toMatch(/max-h-/);
    expect(stack.className).toMatch(/overflow-y-auto/);
    const code = screen.getByRole('alert').querySelector('code')!;
    expect(code.textContent!.length).toBeLessThanOrEqual(161);
    expect(code.textContent!.endsWith('…')).toBe(true);
    expect(code.getAttribute('title')).toBe(long);
  });

  it('ignores a payload that is not an alert it knows', async () => {
    renderBanner();
    await push({ ...metadata, alert: 'exfil' });
    await push(null);
    await push('metadata-endpoint');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

describe('the board mounts it', () => {
  it('App shows an airlock_alert pushed on the socket', async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><App /></QueryClientProvider>);
    expect(screen.getByText('THE BOARD')).toBeTruthy();
    await push(metadata);
    expect(screen.getByRole('alert').getAttribute('data-alert')).toBe('metadata-endpoint');
  });
});
