/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { Logo } from '../components/Logo';

afterEach(cleanup);

describe('Hub Logo', () => {
  it('renders the AgEnFK wordmark and the hub byline', () => {
    render(<Logo version="1.2.3" />);
    const wordmark = screen.getByTestId('logo-wordmark');
    expect(wordmark.textContent).toContain('AgEnFK');
    expect(wordmark.textContent).toMatch(/HUB.*BY\s*CG\/LAB/);
  });

  it('renders the version chip when a version is provided', () => {
    render(<Logo version="1.2.3" />);
    expect(screen.getByTitle('Hub version 1.2.3').textContent).toBe('v1.2.3');
  });

  it('omits the version chip when no version is provided', () => {
    render(<Logo version={null} />);
    expect(screen.queryByTitle(/Hub version/)).toBeNull();
  });

  it('gives two rendered instances distinct gradient ids', () => {
    const { container } = render(
      <div>
        <Logo version={null} />
        <Logo version={null} />
      </div>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((el) => el.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
