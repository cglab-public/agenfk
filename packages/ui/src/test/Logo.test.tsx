import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { Logo } from '../components/Logo';

afterEach(cleanup);

describe('Logo', () => {
  it('renders the AgEnFK wordmark and the CG/lab byline', () => {
    render(<Logo />);
    const wordmark = screen.getByTestId('logo-wordmark');
    expect(wordmark.textContent).toContain('AgEnFK');
    expect(wordmark.textContent).toMatch(/BY\s*CG\/LAB/);
  });

  it('renders the spark mark as an SVG with a gradient stroke', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.querySelector('linearGradient')).toBeTruthy();
    expect(svg?.querySelector('path')?.getAttribute('stroke')).toMatch(/^url\(#/);
  });

  it('gives two rendered instances distinct gradient ids', () => {
    const { container } = render(
      <div>
        <Logo />
        <Logo />
      </div>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((el) => el.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
