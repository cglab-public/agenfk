/**
 * CGLAB-384 (S8-T2) — the editor speaks in plain words, never check ids.
 * The browser cannot import core, so the words live here, keyed by id; these
 * pin them to core's catalogue, roles and presets so neither side drifts.
 */
import { describe, it, expect } from 'vitest';
import { CHECK_CATALOGUE, STEP_ROLES, TDD_FLOW_PRESET, DEFAULT_FLOW } from '@agenfk/core';
import { CHECK_TEXTS, ROLE_TEXTS, RECORD_TEXTS, checkText } from '../checkTexts';
import { FLOW_TEMPLATES } from '../flowTemplates';

describe('check texts', () => {
  it('has a title and a "stops" line for every check in the catalogue', () => {
    for (const id of Object.keys(CHECK_CATALOGUE)) {
      expect(CHECK_TEXTS[id]?.title, id).toBeTruthy();
      expect(CHECK_TEXTS[id]?.stops, id).toBeTruthy();
    }
  });

  it('names and describes every role', () => {
    for (const r of STEP_ROLES) {
      expect(ROLE_TEXTS[r]?.name, r).toBeTruthy();
      expect(ROLE_TEXTS[r]?.desc, r).toBeTruthy();
    }
  });

  it('names every record a check produces or needs', () => {
    for (const rec of ['stepEntryTests', 'redSet', 'testSurface', 'authoredTests']) expect(RECORD_TEXTS[rec], rec).toBeTruthy();
  });

  it('falls back to the server description for a check it does not know', () => {
    expect(checkText('from-the-future', 'Something new.')).toMatchObject({ title: 'from-the-future', stops: 'Something new.' });
  });
});

describe('templates', () => {
  const contractOf = (steps: any[]) => steps.map(s => ({ name: s.name, role: s.role ?? null, checks: s.checks ?? null }));

  it('the TDD template is the shipped TDD preset, roles and checks included', () => {
    expect(contractOf(FLOW_TEMPLATES.tdd.steps)).toEqual(contractOf(TDD_FLOW_PRESET.steps));
  });

  it('the Default template is the built-in default flow', () => {
    expect(contractOf(FLOW_TEMPLATES.default.steps)).toEqual(contractOf(DEFAULT_FLOW.steps));
  });

  it('every template validates on the server', async () => {
    const { flowChecksErrors } = await import('@agenfk/core');
    for (const [k, t] of Object.entries(FLOW_TEMPLATES)) expect(flowChecksErrors(t.steps), k).toEqual([]);
  });
});
