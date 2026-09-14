/**
 * Which agent a terminal launches (CGLAB-169).
 *
 * The Installed / Not installed split is the feature, not styling. Without it
 * an agent the user does not have looks exactly like one they do; they pick it
 * and the terminal opens onto "command not found", which reads as a broken app
 * rather than as a missing install. Showing the absent ones is only worth doing
 * if the row also says how to get them — otherwise the user is told they are
 * stuck and nothing more.
 *
 * The ids here are the wire format the main process matches against its closed
 * list. Labels are for people and are never sent anywhere.
 */
import React from 'react';
import { clsx } from 'clsx';
import { Check, ChevronDown, Search } from 'lucide-react';
import { AgentIcon } from './AgentIcon';

export interface AgentInfo {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
  /**
   * Whether this agent has a flag to skip its own permission prompts.
   *
   * Reported by the main process rather than assumed, so the UI can disable the
   * toggle with a reason instead of offering a control that quietly does
   * nothing — which would tell the user the safety rails are off when they are
   * not.
   */
  readonly supportsAutoApprove?: boolean;
}

export interface AgentPickerProps {
  readonly value: string;
  readonly onChange: (agentId: string) => void;
  readonly listAgents: () => Promise<AgentInfo[]>;
}

/** How to get each agent. Shown on the rows the user cannot pick. */
const INSTALL_HINT: Record<string, string> = {
  pi: 'Install from pi.dev',
  'claude-code': 'Install with: npm i -g @anthropic-ai/claude-code',
  codex: 'Install with: npm i -g @openai/codex',
  gemini: 'Install with: npm i -g @google/gemini-cli',
};

/**
 * Labels for the trigger before detection has answered.
 *
 * The button has to render on first paint, and detection can take a moment —
 * on macOS it may spawn a login shell to get a usable PATH. Showing the raw id
 * until then, and swapping to a label a beat later, is a visible flicker on
 * every open. Presentation only: the ids are the contract with the main
 * process, and these strings are never sent anywhere.
 */
const FALLBACK_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  pi: 'Pi',
  shell: 'Shell',
};

/** A machine where detection failed is not a machine with no terminal. */
const SHELL_FALLBACK: AgentInfo[] = [{ id: 'shell', label: 'Shell', installed: true }];

export function AgentPicker({ value, onChange, listAgents }: AgentPickerProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const menuRef = React.useRef<HTMLDivElement>(null);

  // On mount, not on open: the trigger shows the chosen agent's label, and
  // waiting for the first click to find out what it is means the button reads
  // as a raw id until then.
  React.useEffect(() => {
    if (agents) return;
    let cancelled = false;
    setLoading(true);
    listAgents()
      .then(found => { if (!cancelled) setAgents(found); })
      .catch(() => { if (!cancelled) setAgents(SHELL_FALLBACK); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agents, listAgents]);

  const all = agents ?? [];
  const current = all.find(a => a.id === value);
  const matches = (a: AgentInfo): boolean =>
    a.label.toLowerCase().includes(query.trim().toLowerCase());

  const installed = all.filter(a => a.installed && matches(a));
  const missing = all.filter(a => !a.installed && matches(a));

  const choose = (agent: AgentInfo): void => {
    // A row that cannot work is informative, not selectable.
    if (!agent.installed) return;
    onChange(agent.id);
    setOpen(false);
    setQuery('');
  };

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    // Only the selectable rows take focus: landing on a disabled one is a dead
    // end a keyboard user then has to arrow back out of.
    const rows = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [],
    );
    if (!rows.length) return;

    if (delta !== 0) {
      event.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      rows[(at + delta + rows.length) % rows.length].focus();
      return;
    }
    if (event.key === 'Enter') {
      const focused = document.activeElement as HTMLElement | null;
      const id = focused?.getAttribute('data-agent-id');
      const agent = all.find(a => a.id === id);
      if (agent) {
        event.preventDefault();
        choose(agent);
      }
    }
  };

  const Row = ({ agent }: { agent: AgentInfo }): React.ReactElement => (
    <div
      role="option"
      aria-selected={agent.id === value}
      aria-disabled={!agent.installed}
      data-agent-id={agent.id}
      tabIndex={agent.installed ? -1 : undefined}
      onClick={() => choose(agent)}
      className={clsx(
        'flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm outline-none',
        agent.installed
          ? 'cursor-pointer text-ink hover:bg-canvas focus:bg-canvas'
          : 'cursor-default text-ink-tertiary',
      )}
    >
      <AgentIcon agentId={agent.id} size={18} />
      <span className="flex-1 truncate">{agent.label}</span>
      {!agent.installed && (
        <span className="shrink-0 text-[11px] text-ink-tertiary">
          {INSTALL_HINT[agent.id] ?? 'Not installed'}
        </span>
      )}
      {agent.id === value && agent.installed && <Check size={15} className="shrink-0 text-brand" />}
    </div>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl border border-border-soft bg-canvas px-3 py-2.5 text-sm text-ink transition-colors hover:border-border-brand"
      >
        <AgentIcon agentId={value} size={18} />
        <span className="flex-1 text-left">{current?.label ?? FALLBACK_LABELS[value] ?? value}</span>
        <ChevronDown size={16} className="shrink-0 text-ink-tertiary" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="listbox"
          onKeyDown={onMenuKeyDown}
          className="absolute z-20 mt-1.5 max-h-[22rem] w-full origin-top animate-[popIn_120ms_cubic-bezier(0.2,0,0,1)] overflow-y-auto rounded-xl border border-border-soft bg-nav-surface p-2 shadow-2xl scrollbar-slim motion-reduce:animate-none"
        >
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search agents..."
              className="w-full rounded-lg border border-border-soft bg-canvas py-2 pl-8 pr-3 text-sm text-ink outline-none focus:border-border-brand"
            />
          </div>

          {loading && !agents && (
            <div className="px-2.5 py-3 text-sm text-ink-tertiary">Looking for installed agents…</div>
          )}

          {/* Headings only where there is something under them. */}
          {installed.length > 0 && (
            <div role="group" aria-label="Installed">
              <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-ink-tertiary">
                Installed
              </div>
              {installed.map(a => <Row key={a.id} agent={a} />)}
            </div>
          )}

          {missing.length > 0 && (
            <div role="group" aria-label="Not installed">
              <div className="px-2.5 pb-1 pt-2.5 text-xs font-medium text-ink-tertiary">
                Not installed
              </div>
              {missing.map(a => <Row key={a.id} agent={a} />)}
            </div>
          )}

          {agents && installed.length === 0 && missing.length === 0 && (
            <div className="px-2.5 py-3 text-sm text-ink-tertiary">No agents match “{query}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
