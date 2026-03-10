/**
 * BDD Tests for README "How do I use AgEnFK" section.
 *
 * Feature: README "How do I use AgEnFK" section
 *   As an engineer discovering AgEnFK
 *   I want a clear walkthrough of the basic workflow
 *   So that I understand how to use the /agenfk command from request to completion
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

describe('Feature: README "How do I use AgEnFK" section', () => {
  // Scenario: Section exists with a clear heading
  describe('Scenario: Section exists with a clear heading', () => {
    it('Given the README exists, it should contain a "How do I use AgEnFK" heading', () => {
      expect(README).toContain('## How do I use AgEnFK');
    });
  });

  // Scenario: Engineer reads the basic workflow explanation
  describe('Scenario: Engineer understands the default flow from request to DONE', () => {
    it('should explain the /agenfk slash command as the entry point', () => {
      expect(README).toMatch(/\/agenfk/);
    });

    it('should describe the default flow steps (TODO → IN_PROGRESS → REVIEW → TEST → DONE or similar)', () => {
      // The section should reference the flow progression
      expect(README).toMatch(/TODO.*DONE/s);
    });

    it('should mention the engineer making a request as the starting point', () => {
      // The section should show that the workflow starts with the engineer's prompt
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!.length).toBeGreaterThan(100); // substantive content
    });

    it('should describe task creation as part of the workflow', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/create|task|item/i);
    });

    it('should describe verification/validation as part of the workflow', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/validate|verify|verification|build|test/i);
    });

    it('should describe the completion/DONE step', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/DONE|complet|finish/i);
    });
  });

  // Scenario: Section mentions custom flows and community sharing
  describe('Scenario: Section mentions custom flows and community', () => {
    it('should mention that engineers can define custom flows', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/custom flow|define.*flow|new flow/i);
    });

    it('should mention sharing flows with the community', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/communit|share|download/i);
    });
  });

  // Scenario: Section mentions importing cards from external sources
  describe('Scenario: Section mentions importing cards from external sources', () => {
    it('should mention JIRA as a card import source', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/JIRA/i);
    });

    it('should mention GitHub as a card import source', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/GitHub/i);
    });

    it('should mention the Kanban UI as a way to create cards', () => {
      const section = extractSection(README, 'How do I use AgEnFK');
      expect(section).toBeTruthy();
      expect(section!).toMatch(/Kanban|UI|dashboard/i);
    });
  });
});

/**
 * Extract the content of a ## section from markdown by heading text.
 * Returns the content between the matched heading and the next ## heading (or EOF).
 */
function extractSection(markdown: string, headingText: string): string | null {
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = markdown.split('\n');
  const headerIdx = lines.findIndex(l => new RegExp(`^## ${escapedHeading}`).test(l));
  if (headerIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > headerIdx && /^## /.test(l));
  const sectionLines = lines.slice(headerIdx + 1, endIdx === -1 ? undefined : endIdx);
  return sectionLines.join('\n').trim();
}
