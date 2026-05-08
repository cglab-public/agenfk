import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HUB_UI_ROOT = path.resolve(__dirname, '../..');
const FAVICON_PATH = path.join(HUB_UI_ROOT, 'public', 'hub-logo.svg');
const INDEX_HTML_PATH = path.join(HUB_UI_ROOT, 'index.html');

describe('Hub UI favicon', () => {
  it('ships a purple-themed SVG favicon at public/hub-logo.svg', () => {
    expect(fs.existsSync(FAVICON_PATH), `expected ${FAVICON_PATH} to exist`).toBe(true);
    const svg = fs.readFileSync(FAVICON_PATH, 'utf8');
    expect(svg.startsWith('<svg') || svg.includes('<svg')).toBe(true);
    expect(svg.toLowerCase()).toMatch(/#[a-f0-9]{3,8}|rgb|purple|violet/);
  });

  it('index.html links the favicon via <link rel="icon">', () => {
    const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
    expect(html).toMatch(/<link\s+[^>]*rel=["']icon["'][^>]*href=["']\/hub-logo\.svg["']/);
    expect(html).toMatch(/type=["']image\/svg\+xml["']/);
  });
});
