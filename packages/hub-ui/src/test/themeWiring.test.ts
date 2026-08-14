import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HUB_UI_SRC = path.resolve(__dirname, '..');
const INDEX_CSS_PATH = path.join(HUB_UI_SRC, 'index.css');
const MAIN_TSX_PATH = path.join(HUB_UI_SRC, 'main.tsx');

describe('Hub UI theme wiring', () => {
  it('index.css contains @variant dark referencing .dark and [data-theme="dark"]', () => {
    const css = fs.readFileSync(INDEX_CSS_PATH, 'utf8');
    expect(css).toMatch(/@variant\s+dark\b/);
    expect(css).toMatch(/\.dark/);
    expect(css).toMatch(/\[data-theme=["']dark["']\]/);
  });

  it('main.tsx imports ThemeProvider from "./ThemeContext"', () => {
    const src = fs.readFileSync(MAIN_TSX_PATH, 'utf8');
    expect(src).toMatch(/import\s+.*ThemeProvider.*from\s+['"]\.\/ThemeContext['"]/);
  });

  it('main.tsx renders <ThemeProvider>', () => {
    const src = fs.readFileSync(MAIN_TSX_PATH, 'utf8');
    expect(src).toContain('<ThemeProvider>');
  });
});
