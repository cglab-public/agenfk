/**
 * @vitest-environment jsdom
 *
 * Shared hub-ui primitives on the visual-system tokens (CGLAB-434 S2).
 *
 * Eight files carried their own copies of cardCls / inputCls / primaryBtnCls,
 * ChipRow existed twice, and the only Toggle had no accessible name. These
 * components replace them; the pages move over in S3. Colour is asserted as
 * the token utility a variant must use, because jsdom runs no Tailwind.
 */
import React from 'react';
import { render, screen, fireEvent, cleanup, getDefaultNormalizer } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Button, Card, CardHeader, Badge, Callout, Field, Input, Select, Toggle, StatTile, ChipRow } from '../components/ui';

afterEach(cleanup);

/** Tailwind palette colours the visual system replaces with tokens. */
const RAW_PALETTE = /\b(?:bg|text|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|shadow|caret|accent|decoration)-(?:(?:red|rose|amber|yellow|orange|emerald|green|teal|cyan|sky|blue|indigo|violet|purple|pink|fuchsia|lime|slate|gray|zinc|neutral|stone)-\d{2,3}|white|black)\b/;
const allClasses = (root: HTMLElement) => [root, ...Array.from(root.querySelectorAll('*'))].map(el => el.getAttribute('class') ?? '').join(' ');

describe('Button', () => {
  it('is type="button" unless told otherwise, so it never submits a form by accident', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button>Save</Button></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('can still submit when asked', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('keeps its text colour beside a type-scale size (cn knows the scale is not a colour)', () => {
    render(<Button variant="primary" size="md">Create</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toMatch(/\btext-navy\b/);
    expect(cls).toMatch(/\btext-body\b/);
  });

  it('primary is solid brand teal with navy text: no gradient, no glow', () => {
    render(<Button variant="primary">Create</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toMatch(/\bbg-brand\b/);
    expect(cls).toMatch(/\btext-navy\b/);
    expect(cls).not.toMatch(/gradient|shadow-glow/);
  });

  it('danger uses the reserved status tokens', () => {
    render(<Button variant="danger">Revoke</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toMatch(/\btext-status-danger-text\b/);
    expect(cls).toMatch(/\bbg-status-danger-bg\b/);
  });

  it('secondary and ghost differ from primary and from each other', () => {
    render(<><Button variant="secondary">A</Button><Button variant="ghost">B</Button><Button variant="primary">C</Button></>);
    const [a, b, c] = screen.getAllByRole('button').map(el => el.className);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('sizes change the padding and text size', () => {
    render(<><Button size="sm">S</Button><Button size="md">M</Button></>);
    const [sm, md] = screen.getAllByRole('button').map(el => el.className);
    expect(sm).not.toBe(md);
  });

  it('each variant sets exactly one font weight (two would fight on CSS source order)', () => {
    render(<>{(['primary', 'secondary', 'ghost', 'danger'] as const).map(v => <Button key={v} variant={v}>{v}</Button>)}</>);
    for (const b of screen.getAllByRole('button')) {
      const weights = b.className.split(/\s+/).filter(c => /^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/.test(c));
      expect(weights, `${b.textContent}: ${weights.join(' ')}`).toHaveLength(1);
    }
    expect(screen.getByRole('button', { name: 'primary' }).className).toMatch(/(?:^|\s)font-bold(?:\s|$)/);
  });

  it('every variant has a border, so buttons side by side are the same height', () => {
    render(<>{(['primary', 'secondary', 'ghost', 'danger'] as const).map(v => <Button key={v} variant={v}>{v}</Button>)}</>);
    for (const b of screen.getAllByRole('button')) expect(b.className, b.textContent!).toMatch(/(?:^|\s)border(?:\s|$)/);
  });

  it('ghost stays neutral at rest; secondary sits on the card surface', () => {
    render(<><Button variant="ghost">g</Button><Button variant="secondary">s</Button></>);
    const g = screen.getByRole('button', { name: 'g' }).className.split(/\s+/).filter(c => !c.includes(':'));
    expect(g.filter(c => /^bg-/.test(c))).toEqual(['bg-transparent']);
    expect(screen.getByRole('button', { name: 's' }).className).toMatch(/(?:^|\s)bg-surface(?:\s|$)/);
  });

  it('hover styles only apply while enabled', () => {
    render(<Button variant="primary">p</Button>);
    const hovers = screen.getByRole('button').className.split(/\s+/).filter(c => c.includes('hover:'));
    expect(hovers.length).toBeGreaterThan(0);
    for (const h of hovers) expect(h, h).toMatch(/^enabled:hover:/);
  });

  it('className overrides win over the defaults (merged, not appended)', () => {
    render(<Button size="md" className="px-2">x</Button>);
    const cls = screen.getByRole('button').className.split(/\s+/);
    expect(cls).toContain('px-2');
    expect(cls).not.toContain('px-4');
  });

  it('passes disabled and onClick through', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>X</Button>);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Card and CardHeader', () => {
  it('renders the title as a heading, with description and actions', () => {
    render(
      <Card>
        <CardHeader title="Installations" description="Every install that reported." actions={<Button>Refresh</Button>} />
        <p>body</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Installations', level: 2 })).toBeTruthy();
    expect(screen.getByText('Every install that reported.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
  });

  it('heading level can be set for nested sections', () => {
    render(<Card><CardHeader title="Registry" level={3} /></Card>);
    expect(screen.getByRole('heading', { name: 'Registry', level: 3 })).toBeTruthy();
  });

  it('className overrides win: a flush card can drop the padding', () => {
    const { container } = render(<Card className="p-0">x</Card>);
    const cls = (container.firstElementChild as HTMLElement).className.split(/\s+/);
    expect(cls).toContain('p-0');
    expect(cls).not.toContain('p-5');
  });

  it('is a neutral surface: no accent or series colour on the card itself', () => {
    const { container } = render(<Card>x</Card>);
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toMatch(/\bbg-surface\b|\bbg-card-glass\b/);
    expect(cls).not.toMatch(/accent|series|status|brand/);
  });
});

describe('Badge', () => {
  it.each([
    ['ok', 'status-ok'],
    ['warn', 'status-warn'],
    ['danger', 'status-danger'],
    ['info', 'status-info'],
  ] as const)('tone %s uses the %s text and bg tokens', (tone, token) => {
    render(<Badge tone={tone}>state</Badge>);
    const cls = screen.getByText('state').className;
    expect(cls).toMatch(new RegExp(`\\btext-${token}-text\\b`));
    expect(cls).toMatch(new RegExp(`\\bbg-${token}-bg\\b`));
  });

  it('tone accent uses the indigo accent tokens; neutral uses ink', () => {
    render(<><Badge tone="accent">a</Badge><Badge>n</Badge></>);
    expect(screen.getByText('a').className).toMatch(/\btext-accent-ink\b/);
    expect(screen.getByText('a').className).toMatch(/\bbg-accent-fill\b/);
    expect(screen.getByText('n').className).toMatch(/\btext-ink-secondary\b/);
  });
});

describe('Callout', () => {
  it('is not a live region by default: static messages on page load do not interrupt', () => {
    render(<><Callout tone="danger">broke</Callout><Callout tone="warn">heads up</Callout></>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces when asked: assertive as an alert, polite as a status', () => {
    render(<><Callout tone="danger" live="assertive">broke</Callout><Callout tone="warn" live="polite">heads up</Callout></>);
    expect(screen.getByRole('alert').textContent).toContain('broke');
    expect(screen.getByRole('status').textContent).toContain('heads up');
  });

  it('names its tone in words for screen readers', () => {
    render(<><Callout tone="warn">a</Callout><Callout tone="danger">b</Callout><Callout tone="ok">c</Callout><Callout tone="info">d</Callout></>);
    for (const w of ['Warning:', 'Error:', 'Success:', 'Note:']) {
      expect(screen.getByText(w).className).toMatch(/(?:^|\s)sr-only(?:\s|$)/);
    }
  });

  it('each tone has its own icon', () => {
    const { container } = render(<>{(['ok', 'warn', 'danger', 'info'] as const).map(t => <Callout key={t} tone={t}>x</Callout>)}</>);
    // lucide's own icon-name class (lucide-info, lucide-circle-x, ...), not
    // anything the component adds, so swapping the icon map is caught.
    const icons = Array.from(container.querySelectorAll('svg')).map(svg =>
      (svg.getAttribute('class') ?? '').split(/\s+/).filter(c => /^lucide-/.test(c)).sort().join(' '));
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(4);
  });

  it('shows a title and uses the tone tokens, never raw palette colours', () => {
    const { container } = render(<Callout tone="warn" title="Action required">Set the env var.</Callout>);
    expect(screen.getByText('Action required')).toBeTruthy();
    const cls = allClasses(container.firstElementChild as HTMLElement);
    expect(cls).toMatch(/\btext-status-warn-text\b/);
    expect(cls).not.toMatch(RAW_PALETTE);
  });

  it('carries an icon so state is never colour alone', () => {
    const { container } = render(<Callout tone="ok">done</Callout>);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('Field, Input, Select', () => {
  it('ties the visible label to its control', () => {
    render(<Field label="Admin email"><Input /></Field>);
    expect(screen.getByLabelText('Admin email').tagName).toBe('INPUT');
  });

  it('works for a select too', () => {
    render(<Field label="Role"><Select><option>viewer</option></Select></Field>);
    expect(screen.getByLabelText('Role').tagName).toBe('SELECT');
  });

  it('describes the control with its hint and marks errors invalid', () => {
    render(<Field label="Password" hint="At least 8 characters" error="Too short"><Input /></Field>);
    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent);
    expect(described).toContain('At least 8 characters');
    expect(described).toContain('Too short');
    expect(screen.getByText('Too short').className).toMatch(/\btext-status-danger-text\b/);
  });

  it("keeps the caller's own id and aria-describedby", () => {
    render(<><p id="note">Paste a PR URL</p><Field label="PR number" hint="57 or #57"><Input id="pr-search" aria-describedby="note" /></Field></>);
    const input = screen.getByLabelText('PR number');
    expect(input.id).toBe('pr-search');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toContain('note');
    expect(ids.map(id => document.getElementById(id)?.textContent)).toContain('57 or #57');
  });

  it('an input with a leading icon is still the labelled control', () => {
    const { container } = render(<Field label="PR number" hint="57 or #57"><Input icon={<svg data-testid="ico" />} /></Field>);
    const input = screen.getByLabelText('PR number');
    expect(input.tagName).toBe('INPUT');
    expect(container.querySelector('[data-testid="ico"]')).not.toBeNull();
    expect((input.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent)).toContain('57 or #57');
  });

  it('a Toggle inside a Field keeps the hint', () => {
    render(<Field label="Active" hint="Deactivated users cannot sign in"><Toggle label="Active" checked onChange={() => {}} /></Field>);
    const sw = screen.getByRole('switch', { name: 'Active' });
    expect((sw.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent)).toContain('Deactivated users cannot sign in');
  });

  it('leaves the caller aria-describedby alone when there is no hint or error', () => {
    render(<Field label="Q"><Input aria-describedby="elsewhere" /></Field>);
    expect(screen.getByLabelText('Q').getAttribute('aria-describedby')).toBe('elsewhere');
  });

  it('is valid when there is no error', () => {
    render(<Field label="Name"><Input /></Field>);
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBeNull();
  });

  it('inputs show a focus ring in the focus token', () => {
    render(<Field label="Q"><Input /></Field>);
    const cls = screen.getByLabelText('Q').className;
    expect(cls).toMatch(/focus-visible:ring-focus-ring/);
    // outline-hidden, not outline-none: forced-colors mode drops box-shadow
    // rings, and only a transparent outline survives to show focus there.
    expect(cls).toMatch(/focus-visible:outline-hidden/);
    expect(cls).not.toMatch(/outline-none/);
  });
});

describe('Toggle', () => {
  it('is a named switch that reports and flips its state', () => {
    const onChange = vi.fn();
    render(<Toggle label="Active: alice@acme.dev" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Active: alice@acme.dev' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('on uses the accent, off stays neutral', () => {
    render(<><Toggle label="on" checked onChange={() => {}} /><Toggle label="off" checked={false} onChange={() => {}} /></>);
    expect(screen.getByRole('switch', { name: 'on' }).className).toMatch(/(?:^|\s)bg-accent(?:\s|$)/);
    const off = screen.getByRole('switch', { name: 'off' }).className;
    expect(off).not.toMatch(/\bbg-accent\b/);
    // Off must still be visible (WCAG 1.4.11): a track in ink-tertiary, not the
    // 1.2:1 border-soft it replaces.
    expect(off).toMatch(/(?:^|\s)bg-ink-tertiary(?:\s|$)/);
  });

  it('respects disabled', () => {
    const onChange = vi.fn();
    render(<Toggle label="x" checked onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StatTile', () => {
  it('shows label and formatted value', () => {
    render(<StatTile label="Items closed" value={1548} />);
    expect(screen.getByText('Items closed')).toBeTruthy();
    // Compare uncollapsed: the default normalizer turns fr-FR's narrow no-break
    // space into a plain one, which the expected string still carries.
    expect(screen.getByText((1548).toLocaleString(), { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) })).toBeTruthy();
  });

  it('a rise is marked ok with an arrow and a word for screen readers', () => {
    render(<StatTile label="PRs" value={190} delta={8} />);
    const d = screen.getByTestId('stat-delta');
    expect(d.textContent).toMatch(/▲\s*8%/);
    expect(d.className).toMatch(/\btext-status-ok-text\b/);
    expect(d.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/▲\s*8%/);
    expect(d.querySelector('.sr-only')?.textContent).toMatch(/up 8%, better/i);
  });

  it('a fall is marked danger; zero is neutral; a missing delta renders nothing', () => {
    render(<><StatTile label="a" value={1} delta={-2} /><StatTile label="b" value={1} delta={0} /><StatTile label="c" value={1} /></>);
    const [down, flat] = screen.getAllByTestId('stat-delta');
    expect(down.className).toMatch(/\btext-status-danger-text\b/);
    expect(down.querySelector('.sr-only')?.textContent).toMatch(/down 2%, worse/i);
    expect(flat.className).not.toMatch(/status-(ok|danger)/);
    expect(screen.getAllByTestId('stat-delta')).toHaveLength(2);
  });

  it('no nonsense for edge cases: infinite and NaN render nothing, a sub-1% change is flat', () => {
    render(<><StatTile label="inf" value={1} delta={Infinity} /><StatTile label="nan" value={1} delta={NaN} /><StatTile label="tiny" value={1} delta={0.4} /></>);
    const shown = screen.getAllByTestId('stat-delta');
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toMatch(/flat/);
    expect(shown[0].className).not.toMatch(/status-(ok|danger)/);
  });

  it('higherIsBetter=false flips the tone (e.g. failures going up is bad)', () => {
    render(<StatTile label="Check failures" value={128} delta={5} higherIsBetter={false} />);
    expect(screen.getByTestId('stat-delta').className).toMatch(/\btext-status-danger-text\b/);
  });

  it('a series swatch keys the tile to its chart colour', () => {
    render(<StatTile label="Closed" value={3} series={3} />);
    expect(screen.getByTestId('stat-swatch').className).toMatch(/\bbg-series-3\b/);
  });

  it('is not interactive: no hover glow on a tile that does nothing', () => {
    const { container } = render(<StatTile label="x" value={1} />);
    expect(allClasses(container.firstElementChild as HTMLElement)).not.toMatch(/hover:shadow-glow/);
  });
});

describe('ChipRow', () => {
  const setup = (selected: string[] = []) => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(<ChipRow label="Item type" options={['BUG', 'EPIC']} selected={new Set(selected)} onToggle={onToggle} onClear={onClear} />);
    return { onToggle, onClear };
  };

  it('is a labelled group of toggle buttons that announce their state', () => {
    setup(['BUG']);
    const group = screen.getByRole('group', { name: 'Item type' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('button', { name: 'BUG' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'EPIC' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('selected chips use the indigo accent', () => {
    setup(['BUG']);
    // Whole class only: an unselected chip may carry hover:text-accent-ink.
    const plain = /(?:^|\s)text-accent-ink(?:\s|$)/;
    expect(screen.getByRole('button', { name: 'BUG' }).className).toMatch(plain);
    expect(screen.getByRole('button', { name: 'EPIC' }).className).not.toMatch(plain);
  });

  it('toggles and clears', () => {
    const { onToggle, onClear } = setup(['BUG']);
    fireEvent.click(screen.getByRole('button', { name: 'EPIC' }));
    expect(onToggle).toHaveBeenCalledWith('EPIC');
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(onClear).toHaveBeenCalled();
  });

  it('hides Clear when nothing is selected and renders nothing without options', () => {
    setup();
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    cleanup();
    const { container } = render(<ChipRow label="x" options={[]} selected={new Set()} onToggle={() => {}} onClear={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('every primitive', () => {
  it('uses tokens only: no raw Tailwind palette colours in any variant', () => {
    const { container } = render(
      <div>
        {(['primary', 'secondary', 'ghost', 'danger'] as const).map(v => <Button key={v} variant={v}>b</Button>)}
        <Card><CardHeader title="t" description="d" /></Card>
        {(['ok', 'warn', 'danger', 'info', 'accent', 'neutral'] as const).map(t => <Badge key={t} tone={t}>b</Badge>)}
        {(['ok', 'warn', 'danger', 'info'] as const).map(t => <Callout key={t} tone={t}>c</Callout>)}
        <Field label="f" hint="h" error="e"><Input /></Field>
        <Field label="s"><Select><option>o</option></Select></Field>
        <Toggle label="t1" checked onChange={() => {}} /><Toggle label="t2" checked={false} onChange={() => {}} />
        <StatTile label="s" value={1} delta={1} series={1} /><StatTile label="s2" value={1} delta={-1} />
        <ChipRow label="c" options={['a', 'b']} selected={new Set(['a'])} onToggle={() => {}} onClear={() => {}} />
      </div>,
    );
    expect(allClasses(container)).not.toMatch(RAW_PALETTE);
  });
});

describe('the primitives only use colours the tokens define', () => {
  it('every colour utility in components/ui names a --color-* token (or a Tailwind keyword)', () => {
    const tokens = fs.readFileSync(path.resolve(__dirname, '../../../brand/tokens.css'), 'utf8');
    const theme = tokens.slice(tokens.indexOf('@theme {'));
    const colours = new Set([...theme.matchAll(/--color-([\w-]+)\s*:/g)].map(m => m[1]));
    for (const k of ['transparent', 'current', 'inherit']) colours.add(k);
    const dir = path.resolve(__dirname, '../components/ui');
    const PREFIX = /(?:^|[\s'"`:])(?:bg|text|border|ring|outline|fill|stroke|divide|caret)-([a-z][\w-]*?)(?:\/\d+)?(?=[\s'"`]|$)/g;
    // Non-colour utilities sharing those prefixes.
    const NOT_COLOUR = /^(caption|small|body|title|display|xs|sm|base|lg|xl|\d?xl|\d+|\[.*\]|left|right|center|justify|wrap|nowrap|balance|ellipsis|clip|x|y|t|b|l|r|none|hidden|solid|dashed|dotted|double|offset.*|inset|collapse|separate|spacing.*|opacity.*|image.*|fixed|local|scroll|cover|contain|auto|repeat.*|no-repeat|origin.*|clip.*|blend.*)$/;
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.tsx'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(PREFIX)) {
        const name = m[1];
        if (NOT_COLOUR.test(name)) continue;
        if (!colours.has(name)) bad.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
