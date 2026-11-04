/**
 * INFRA-425: turning a cockpit snapshot into the gadgets in the terminal
 * header. Same rules as the pi cockpit: prod in red, an AWS session expiring in
 * under ten minutes in red, EXPIRED when it has.
 */
import { describe, it, expect } from 'vitest';
import { cockpitGadgets } from '../cockpit';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const all = { git: true, aws: true, k8s: true, tf: true, ctx: true, cost: true };

describe('cockpit gadgets', () => {
  it('shows the branch with its dirty mark and ahead/behind', () => {
    const [g] = cockpitGadgets({ git: { branch: 'main', dirty: true, ahead: 2, behind: 1 } }, NOW, all);
    expect(g).toMatchObject({ id: 'git', text: 'main* ↑2 ↓1', tone: 'normal' });
  });

  it('colours a prod AWS profile and counts down its session', () => {
    const [g] = cockpitGadgets({ aws: { profile: 'cglab-prod-ro', expires: '2026-10-08T13:30:00Z' } }, NOW, all);
    expect(g).toMatchObject({ id: 'aws', text: 'cglab-prod-ro ↻1h30m', tone: 'danger' });
  });

  it('warns in red under ten minutes, and says EXPIRED after', () => {
    expect(cockpitGadgets({ aws: { profile: 'cglab-stg', expires: '2026-10-08T12:05:00Z' } }, NOW, all)[0])
      .toMatchObject({ text: 'cglab-stg ↻5m', tone: 'danger' });
    expect(cockpitGadgets({ aws: { profile: 'cglab-stg', expires: '2026-10-08T11:00:00Z' } }, NOW, all)[0])
      .toMatchObject({ text: 'cglab-stg EXPIRED', tone: 'danger' });
  });

  it('marks a profile read from the shell\'s start environment as possibly stale', () => {
    expect(cockpitGadgets({ aws: { profile: 'cglab-stg', expires: null, source: 'shell' } }, NOW, all)[0].caveat).toMatch(/export/);
    expect(cockpitGadgets({ aws: { profile: 'cglab-stg', expires: null, source: 'reported' } }, NOW, all)[0].caveat).toBeUndefined();
  });

  it('shows a stg profile with no known expiry plainly', () => {
    expect(cockpitGadgets({ aws: { profile: 'cglab-stg', expires: null } }, NOW, all)[0])
      .toMatchObject({ text: 'cglab-stg', tone: 'warn' });
  });

  it('treats prod and prd as words, not as letters inside product or reproduce', () => {
    expect(cockpitGadgets({ tf: 'product-catalog' }, NOW, all)[0].tone).toBe('normal');
    expect(cockpitGadgets({ k8s: 'reproduce-lab' }, NOW, all)[0].tone).toBe('normal');
    expect(cockpitGadgets({ tf: 'prd' }, NOW, all)[0].tone).toBe('danger');
    expect(cockpitGadgets({ k8s: 'eks-production' }, NOW, all)[0].tone).toBe('danger');
    expect(cockpitGadgets({ tf: 'prd01' }, NOW, all)[0].tone).toBe('danger');
    expect(cockpitGadgets({ tf: 'prod1' }, NOW, all)[0].tone).toBe('danger');
  });

  it('colours a prod kube context', () => {
    expect(cockpitGadgets({ k8s: 'arn:aws:eks:x:860059903058:cluster/prd-main' }, NOW, all)[0]).toMatchObject({ id: 'k8s', tone: 'danger' });
    expect(cockpitGadgets({ k8s: 'kind-local' }, NOW, all)[0]).toMatchObject({ tone: 'normal' });
  });

  it('shows context as a share of the window, and cost in dollars', () => {
    const gadgets = cockpitGadgets({ usage: { contextTokens: 400_000, contextWindow: 1_000_000, cost: 1.5, costComplete: true } }, NOW, all);
    expect(gadgets.find(g => g.id === 'ctx')).toMatchObject({ text: '40% · 400k', tone: 'normal' });
    expect(gadgets.find(g => g.id === 'cost')).toMatchObject({ text: '$1.50' });
  });

  it('warns as the context fills, and says when the cost is a lower bound', () => {
    const gadgets = cockpitGadgets({ usage: { contextTokens: 900_000, contextWindow: 1_000_000, cost: 0.2, costComplete: false } }, NOW, all);
    expect(gadgets.find(g => g.id === 'ctx')?.tone).toBe('danger');
    expect(gadgets.find(g => g.id === 'cost')?.text).toBe('≥$0.20');
  });

  it('shows the context as a token count when the window is unknown', () => {
    expect(cockpitGadgets({ usage: { contextTokens: 12_345, contextWindow: null, cost: 0, costComplete: true } }, NOW, all)
      .find(g => g.id === 'ctx')?.text).toBe('12k');
  });

  it('leaves out every gadget that is switched off, and every one with nothing to say', () => {
    expect(cockpitGadgets({ git: { branch: 'main', dirty: false, ahead: 0, behind: 0 }, tf: null }, NOW, { ...all, git: false })).toEqual([]);
  });
});
