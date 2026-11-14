/**
 * @vitest-environment jsdom
 *
 * The flow editor (shared by the hub and the local board) renders on the
 * visual-system tokens only (CGLAB-434 S4): no raw Tailwind palette colours,
 * no gradients, glow or old teal chrome, teal only on primary buttons. Role
 * swatches are token colours, fixed per role, so a role looks the same in the
 * editor and on the board's column badges in both themes.
 */
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeFlowContract } from '@agenfk/core';
import { FlowEditorModal } from '../FlowEditorModal';
import { ROLE_TEXTS } from '../checkTexts';
import type { Flow, FlowClient, FlowStep, RegistryClient } from '../types';

// Slate is allowed: brand/tokens.css remaps it to the neutral grey ramp, and it
// is the editor's neutral base in both apps. A translucent black (bg-black/40)
// is a modal scrim and allowed; solid white/black text or fills are not.
const RAW_PALETTE = /\b(?:bg|text|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|shadow|caret|accent|decoration|placeholder)-(?:(?:red|rose|amber|yellow|orange|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|pink|fuchsia|lime)-\d{2,3}|white)\b|\b(?:bg|text|border|ring)-black\b(?!\/\d)|\b(?:text|border|ring)-black\/\d+/;
const OLD_ACCENT = /(?:^|\s|:)(?:(?:bg|from|to|via)-chip(?:\/\d+)?|(?:border|outline|ring)-border-brand(?:\/\d+)?|bg-mint(?:\/\d+)?|bg-brand\/\d+|text-brand-dark|text-brand-light|shadow-glow|bg-gradient-[\w-]+|bg-\[image:var\(--gradient-accent\)\]|(?:border|ring|outline)-brand(?:\/\d+)?|ring-brand)(?=\s|$)/;

const s = (name: string, order: number, extra: Partial<FlowStep> = {}): FlowStep => ({ id: `id-${name}`, name, label: name, order, ...extra });
const FLOW: Flow = {
  id: 'f1', name: 'My flow', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  steps: [
    s('TODO', 0, { isAnchor: true }),
    // An orphan check (red set before any test-writing step) so the contract
    // problems banner renders and is checked too.
    s('LOOSE', 1, { checks: [{ id: 'red-set-passes-by-name' }] }),
    s('SPECS', 2, { role: 'test-authoring' }),
    s('BUILD', 3, { role: 'coding', checks: [{ id: 'human-approval' }] }),
    s('DONE', 4, { isAnchor: true }),
  ],
};

function mount() {
  const flowClient: FlowClient = {
    listFlows: async () => [FLOW],
    getDefaultFlow: async () => ({ ...FLOW, id: 'default', name: 'Default', steps: [] }),
    createFlow: async p => ({ ...FLOW, ...p } as Flow),
    updateFlow: async (_id, p) => ({ ...FLOW, ...p } as Flow),
    deleteFlow: async () => {},
    setProjectFlow: async () => {},
    getFlowContract: vi.fn(async (steps: FlowStep[]) => describeFlowContract(steps) as any),
  };
  const registryClient: RegistryClient = { browseRegistry: async () => [], installFromRegistry: async () => FLOW };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FlowEditorModal isOpen onClose={() => {}} projectId="p1" initialFlowId="f1" flowClient={flowClient} registryClient={registryClient} />
    </QueryClientProvider>,
  );
}

function expectOnTokens(root: HTMLElement) {
  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  const cls = els.map(el => el.getAttribute('class') ?? '').join(' ');
  expect(cls.match(RAW_PALETTE)?.[0] ?? null, 'raw palette colour').toBeNull();
  expect(cls.match(OLD_ACCENT)?.[0]?.trim() ?? null, 'old teal accent / gradient / glow').toBeNull();
  expect(cls.match(/(?:^|\s|:)text-accent-text(?:\s|$)/)?.[0] ?? null, 'teal text').toBeNull();
  for (const el of els) {
    if (/(?:^|\s)bg-brand(?:\s|$)/.test(el.getAttribute('class') ?? '')) {
      expect(el.tagName, `bg-brand on <${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 24)}"`).toBe('BUTTON');
    }
    // Inline colours (role swatches, step dots) must come from tokens too.
    const style = el.getAttribute('style') ?? '';
    expect(style.match(/#[0-9a-f]{3,8}\b|rgba?\(/i)?.[0] ?? null, `inline colour on <${el.tagName.toLowerCase()}>`).toBeNull();
  }
}

afterEach(() => cleanup());

describe('flow editor colours', () => {
  it('the editor, with a step contract panel open, is on tokens only', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByDisplayValue('BUILD').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('step-contract-btn-3')).toBeTruthy());
    fireEvent.click(screen.getByTestId('step-contract-btn-3'));
    // The dialog must actually be open, or its colours go unchecked.
    await screen.findByRole('dialog', { name: /Checks for BUILD/i });
    expectOnTokens(document.body);
  });

  it('a step without its own colour gives the native colour input a real hex (not black)', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByDisplayValue('BUILD').length).toBeGreaterThan(0));
    const input = screen.getByTestId('step-color-3') as HTMLInputElement;
    expect(input.value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(input.value.toLowerCase()).not.toBe('#000000');
  });

  it('the editor footer has one primary action', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByDisplayValue('BUILD').length).toBeGreaterThan(0));
    const primaries = Array.from(document.body.querySelectorAll('button')).filter(b => /(?:^|\s)bg-brand(?:\s|$)/.test(b.className));
    expect(primaries.map(b => b.textContent?.trim())).toHaveLength(1);
  });

  it('every role swatch is a token colour, and no two roles share one', () => {
    const colours = Object.entries(ROLE_TEXTS).map(([, r]) => r.color);
    for (const c of colours) expect(c).toMatch(/^var\(--[\w-]+\)$/);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('roles never borrow the reserved danger or warning colours', () => {
    for (const [role, r] of Object.entries(ROLE_TEXTS)) expect(r.color, role).not.toMatch(/status-(danger|warn)/);
  });
});
