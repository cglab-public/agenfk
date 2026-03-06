import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence, LayoutGroup, useAnimation } from 'framer-motion';
import { api } from '../api';
import { AgenFKItem, ItemType, Status, Project, Flow, FlowStep } from '../types';
import { clsx } from 'clsx';
import {
  Plus, Loader2, AlertCircle,
  Zap, ChevronRight, Home,
  Sun, Moon, Search, Archive, ArchiveRestore, ChevronLeft,
  FolderOpen, Briefcase, Clock, FlaskConical, ShieldCheck,
  Copy, Check, Download, Pin, PinOff, ExternalLink, Trash2, Lightbulb, Book, Pause,
  ChevronUp, ChevronDown, X, FolderInput, GitBranch
} from 'lucide-react';
import { io } from 'socket.io-client';
import { CardDetailModal } from './CardDetailModal';
import { CardAnimationWrapper } from '../animations/CardAnimationWrapper';
import '../animations'; // Side-effect: registers all easter egg animations
import { useEasterEggs } from '../useEasterEggs';
import { JiraConnectionButton } from './JiraConnectionButton';
import { JiraImportModal } from './JiraImportModal';
import { GitHubImportModal } from './GitHubImportModal';
import { ReleaseReminder } from './ReleaseReminder';
import { WhatsNewModal } from './WhatsNewModal';
import { ReadmeModal } from './ReadmeModal';
import { FlowEditorModal } from './FlowEditorModal';
import { useTheme } from '../ThemeContext';
import { Logo } from './Logo';
import { capture } from '../posthog';
import { calculateCost, formatCost, calculateCycleTimeMs, formatDuration } from '../utils';

// Fallback column list used when the flow fetch fails or is loading
const FALLBACK_STATUSES = [
  Status.TODO,
  Status.IN_PROGRESS,
  Status.REVIEW,
  Status.TEST,
  Status.DONE
];

// Special statuses that are always shown in sidebar sections, never in main columns
const SIDEBAR_STATUSES = new Set([Status.IDEAS, Status.PAUSED, Status.BLOCKED, Status.ARCHIVED]);

interface NavItem {
  id: string;
  title: string;
  type: ItemType;
}

const statusBorderColors: Record<Status, string> = {
  [Status.IDEAS]: "border-t-indigo-400",
  [Status.TODO]: "border-t-slate-400",
  [Status.IN_PROGRESS]: "border-t-blue-500",
  [Status.TEST]: "border-t-purple-500",
  [Status.REVIEW]: "border-t-amber-500",
  [Status.DONE]: "border-t-emerald-500",
  [Status.BLOCKED]: "border-t-red-500",
  [Status.PAUSED]: "border-t-orange-400",
  [Status.ARCHIVED]: "border-t-gray-300",
};

const statusIcons: Record<Status, React.ReactNode> = {
  [Status.IDEAS]: <Lightbulb size={14} />,
  [Status.TODO]: <Plus size={14} />,
  [Status.IN_PROGRESS]: <Zap size={14} />,
  [Status.TEST]: <FlaskConical size={14} />,
  [Status.REVIEW]: <ShieldCheck size={14} />,
  [Status.DONE]: <ChevronRight size={14} />,
  [Status.BLOCKED]: <AlertCircle size={14} />,
  [Status.PAUSED]: <Pause size={14} />,
  [Status.ARCHIVED]: <Archive size={14} />,
};

interface KanbanCardProps {
  item: AgenFKItem;
  items?: AgenFKItem[];
  projects?: Project[];
  highlightedId: string | null;
  dragId: string | null;
  dropTargetId: string | null;
  dropPosition: 'above' | 'below';
  copiedId: string | null;
  pricesData: any;
  isUserAction: boolean;
  onCardDragStart: (e: React.DragEvent, id: string) => void;
  onCardDragEnd: () => void;
  onCardDragOver: (e: React.DragEvent, targetId: string) => void;
  onCardDragLeave: (e: React.DragEvent) => void;
  onDoubleClick: () => void;
  onDrillDown: (item: AgenFKItem) => void;
  onArchive: (id: string) => void;
  onMoveToProject: (id: string, targetProjectId: string) => void;
  onCopyId: (id: string) => void;
  disableLayoutAnimation?: boolean;
}

const KanbanCard: React.FC<KanbanCardProps> = ({
  item, items, projects, highlightedId, dragId, dropTargetId, dropPosition,
  copiedId, pricesData, isUserAction, onCardDragStart, onCardDragEnd, onCardDragOver,
  onCardDragLeave, onDoubleClick, onDrillDown, onArchive, onMoveToProject, onCopyId, disableLayoutAnimation
}) => {
  const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false);
  const [isFlying, setIsFlying] = useState(false);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const lastStatus = React.useRef(item.status);
  const lastUpdate = React.useRef(item.updatedAt);
  const lastSortOrder = React.useRef(item.sortOrder);
  const lastContentKey = React.useRef(JSON.stringify({
    t: item.title,
    d: item.description,
    tu: item.tokenUsage?.length,
    r: item.reviews?.length,
    c: item.comments?.length
  }));
  const controls = useAnimation();

  /* v8 ignore start */
  useEffect(() => {
    if (item.updatedAt !== lastUpdate.current) {
      const contentKey = JSON.stringify({
        t: item.title,
        d: item.description,
        tu: item.tokenUsage?.length,
        r: item.reviews?.length,
        c: item.comments?.length
      });

      const wasManual = isUserAction;
      const statusChanged = item.status !== lastStatus.current;
      const sortOrderChanged = item.sortOrder !== lastSortOrder.current;
      const contentChanged = contentKey !== lastContentKey.current;

      lastUpdate.current = item.updatedAt;
      lastStatus.current = item.status;
      lastSortOrder.current = item.sortOrder;
      lastContentKey.current = contentKey;

      if (!isFlying && !wasManual && !statusChanged && !sortOrderChanged && contentChanged) {
        controls.start({
          scale: [1, 0.92, 1],
          transition: { duration: 0.5, ease: "easeInOut" }
        });
      }
    }
  }, [item.updatedAt, item.status, item.sortOrder, item.title, item.description, item.tokenUsage, item.reviews, item.comments, isFlying, controls, isUserAction]);

  useEffect(() => {
    if (item.status !== lastStatus.current) {
      const wasManual = isUserAction;
      lastStatus.current = item.status;

      if (!wasManual && !disableLayoutAnimation) {
        setIsFlying(true);
        const timer = setTimeout(() => {
          setIsFlying(false);
          cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 600);
        return () => clearTimeout(timer);
      }
    }
  }, [item.status, isUserAction, disableLayoutAnimation]);

  useEffect(() => {
    if (isFlying) {
      controls.start("flying");
    } else {
      controls.start("idle");
    }
  }, [isFlying, controls]);
  /* v8 ignore stop */

  return (
    <motion.div
      ref={cardRef}
      layout={disableLayoutAnimation ? false : "position"}
      layoutId={disableLayoutAnimation ? undefined : item.id}
      id={`card-${item.id}`}
      initial={false}
      animate={controls}
      variants={{
        flying: {
          scale: 1.05,
          zIndex: 9999,
          y: -5,
          boxShadow: "0 25px 50px -12px rgba(99, 102, 241, 0.25)",
        },
        idle: {
          scale: 1,
          zIndex: 1,
          y: 0,
          boxShadow: "0 1px 3px 0 rgb(0 0 0 / 0.1)",
          transition: { type: "spring", stiffness: 300, damping: 30 }
        }
      }}
      transition={{ 
        layout: { 
          type: "spring", 
          stiffness: 260, 
          damping: 30,
          mass: 1
        },
      }}
      className={clsx(
        "group bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-800 cursor-move hover:shadow-lg dark:hover:shadow-indigo-900/20 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors duration-200",
        highlightedId === item.id && "search-highlight border-indigo-500 dark:border-indigo-500",
        dragId === item.id && "opacity-40",
        isFlying ? "!z-[9999] isolate" : (highlightedId === item.id ? "z-20 relative" : "z-0 relative")
      )}
      style={{
        transformOrigin: 'center center',
        willChange: 'transform',
        backfaceVisibility: 'hidden',
        WebkitFontSmoothing: 'antialiased',
      }}
      draggable
      onDragStart={(e: any) => onCardDragStart(e, item.id)}
      onDragEnd={onCardDragEnd}
      onDragOver={(e: any) => onCardDragOver(e, item.id)}
      onDragLeave={onCardDragLeave}
      onDoubleClick={onDoubleClick}
    >
      {dropTargetId === item.id && dropPosition === 'above' && (
        <div className="absolute -top-[1px] left-0 right-0 h-[2px] bg-indigo-500 rounded-t-xl z-50 pointer-events-none" />
      )}
      {dropTargetId === item.id && dropPosition === 'below' && (
        <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-indigo-500 rounded-b-xl z-50 pointer-events-none" />
      )}
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-1.5">
          <span className={clsx("text-[9px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider flex items-center gap-1", item.type === ItemType.EPIC ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800" : item.type === ItemType.STORY ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800" : item.type === ItemType.TASK ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" : "bg-rose-50 dark:bg-rose-900/20 text-red-700 dark:text-red-300 border-red-100 dark:border-red-800")}>
            {item.type}
          </span>
          {(item.type === ItemType.EPIC || item.type === ItemType.STORY) && items?.some((i: AgenFKItem) => i.parentId === item.id) && (
            <button onClick={(e) => { e.stopPropagation(); onDrillDown(item); }} className="bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800 text-indigo-600 dark:text-indigo-400 px-1.5 py-0.5 rounded text-[9px] font-bold flex items-center gap-1 transition-colors">
              <Search size={9} /> {items?.filter((i: AgenFKItem) => i.parentId === item.id).length}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {projects && projects.filter(p => p.id !== item.projectId).length > 0 && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setIsMoveMenuOpen(v => !v); }}
                className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-300 dark:text-slate-600 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                title="Move to project"
              >
                <FolderInput size={11} />
              </button>
              {isMoveMenuOpen && (
                <div
                  className="absolute right-0 top-5 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[140px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Move to project</p>
                  {projects.filter(p => p.id !== item.projectId).map(p => (
                    <button
                      key={p.id}
                      className="w-full text-left px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-700 dark:hover:text-indigo-300 truncate"
                      onClick={() => { setIsMoveMenuOpen(false); onMoveToProject(item.id, p.id); }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={(e) => { e.stopPropagation(); onArchive(item.id); }} className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
            <Archive size={11} />
          </button>
        </div>
      </div>
      <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-[13px] leading-snug mb-1.5 group-hover:text-indigo-700 dark:group-hover:text-indigo-400 transition-colors">{item.title}</h3>
      {!item.parentId && (item.branchName || item.prUrl) && (
        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
          {item.branchName && (
            <span className="inline-flex items-center font-mono text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 truncate max-w-[140px]" title={item.branchName}>
              {item.branchName}
            </span>
          )}
          {item.prUrl && (
            <a
              href={item.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-medium border transition-colors ${
                item.prStatus === 'merged'  ? 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 dark:hover:bg-emerald-900' :
                item.prStatus === 'closed'  ? 'bg-rose-50 dark:bg-rose-950 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800 hover:bg-rose-100 dark:hover:bg-rose-900' :
                item.prStatus === 'draft'   ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700' :
                                              'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900'
              }`}
              title={`PR: ${item.prStatus || 'open'}`}
            >
              PR {item.prStatus === 'merged' ? '✓' : item.prStatus === 'closed' ? '✗' : '↗'}
            </a>
          )}
        </div>
      )}
      {item.description && <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2 mb-2">{item.description}</p>}
      
      {(item.type === ItemType.EPIC || item.type === ItemType.STORY) && (
        <div className="mb-2">
          {(() => {
            const subitems = items?.filter((i: AgenFKItem) => i.parentId === item.id) || [];
            if (subitems.length === 0) return null;
            const progress = Math.round((subitems.filter((i: AgenFKItem) => i.status === Status.DONE).length / subitems.length) * 100);
            return (
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[8px] font-bold text-slate-400 uppercase tracking-tighter">
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-1 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden border border-slate-50 dark:border-slate-800">
                  <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${progress}%` }} />
                </div>
              </div>
            );
          })()}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-slate-50 dark:border-slate-800 mt-auto text-[9px] text-slate-400 dark:text-slate-500 font-mono">
        <div className="flex items-center gap-1.5">
          {item.externalUrl && (
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-indigo-500 hover:text-indigo-700 transition-colors flex items-center gap-0.5"
              title={item.externalUrl.includes('github.com') ? `GitHub Issue #${item.externalId}` : `Open JIRA: ${item.externalId}`}
            >
              {item.externalUrl.includes('github.com') ? (
                <>
                  <svg width={9} height={9} viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  <span className="font-bold">#{item.externalId}</span>
                </>
              ) : (
                <ExternalLink size={9} />
              )}
            </a>
          )}
          <div 
            className="flex items-center gap-1 group/id cursor-pointer" 
            onClick={(e) => { e.stopPropagation(); onCopyId(item.id); }}
            title="Copy Full ID"
          >
            <span className="group-hover/id:text-indigo-500 transition-colors">#{item.id.substring(0, 4)}</span>
            <div className="opacity-0 group-hover/id:opacity-100 transition-opacity">
              {copiedId === item.id ? <Check size={9} className="text-emerald-500" /> : <Copy size={9} />}
            </div>
          </div>
          <div className="flex items-center gap-1 font-medium text-slate-500 dark:text-slate-400">
            <Clock size={9} />
            {calculateCycleTimeMs(item) > 0 || (item.status !== Status.TODO && item.status !== Status.BLOCKED)
              ? formatDuration(calculateCycleTimeMs(item))
              : 'Not started'
            }
          </div>
        </div>
        {/* Hiding tokens for now due to algorithm enhancements
        {item.tokenUsage && item.tokenUsage.length > 0 && (
          <div className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 rounded-full">
            <Zap size={9} className="fill-amber-600" />
            {item.tokenUsage.reduce((acc, curr) => acc + curr.input + curr.output, 0).toLocaleString()}
          </div>
        )}
        */}
      </div>
    </motion.div>
  );
};

export const KanbanBoard: React.FC = () => {
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const easterEggsEnabled = useEasterEggs();
  
  // Project State
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => localStorage.getItem('agenfk_project_id'));
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [isPinned, setIsPinned] = useState<boolean>(() => localStorage.getItem('agenfk_project_pinned') === 'true');
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);

  const togglePin = () => {
    setIsPinned(prev => {
      const next = !prev;
      if (next) {
        localStorage.setItem('agenfk_project_pinned', 'true');
      } else {
        localStorage.removeItem('agenfk_project_pinned');
      }
      return next;
    });
  };
  const [isJiraImportOpen, setIsJiraImportOpen] = useState(false);
  const [isGitHubImportOpen, setIsGitHubImportOpen] = useState(false);
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const [isReadmeOpen, setIsReadmeOpen] = useState(false);
  const [isFlowEditorOpen, setIsFlowEditorOpen] = useState(false);

  const { data: versionData } = useQuery({
    queryKey: ['version'],
    queryFn: api.getVersion,
    staleTime: Infinity,
  });

  const { data: jiraStatus } = useQuery({
    queryKey: ['jiraStatus'],
    queryFn: api.getJiraStatus,
    staleTime: 30_000,
  });

  const { data: ghStatus } = useQuery({
    queryKey: ['githubStatus', selectedProjectId],
    queryFn: () => api.getGitHubStatus(selectedProjectId!),
    enabled: !!selectedProjectId,
    staleTime: 30_000,
  });

  const { data: projects, isLoading: isLoadingProjects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.listProjects()
  });

  // Clear stale localStorage project ID if it no longer exists in the DB
  useEffect(() => {
    if (isLoadingProjects || !projects) return;
    if (selectedProjectId && !projects.find(p => p.id === selectedProjectId)) {
      const fallback = projects.length === 1 ? projects[0].id : null;
      if (fallback !== selectedProjectId) {
        setSelectedProjectId(fallback);
      }
      if (fallback) {
        localStorage.setItem('agenfk_project_id', fallback);
      } else {
        localStorage.removeItem('agenfk_project_id');
      }
    }
  }, [projects, isLoadingProjects, selectedProjectId]);

  const { data: items, isLoading } = useQuery({
    queryKey: ['items', selectedProjectId],
    queryFn: () => api.listItems({ includeArchived: true, projectId: selectedProjectId || undefined }),
    enabled: !!selectedProjectId
  });

  const { data: activeFlow, isLoading: isLoadingFlow, isError: isFlowError } = useQuery<Flow>({
    queryKey: ['flow', selectedProjectId],
    queryFn: () => api.getProjectFlow(selectedProjectId!),
    enabled: !!selectedProjectId,
    staleTime: 30_000,
  });

  // Derive the main (non-sidebar) column statuses from the active flow, sorted by order.
  // Falls back to FALLBACK_STATUSES if the flow hasn't loaded yet or errored.
  const mainColumnStatuses: Status[] = React.useMemo(() => {
    if (!activeFlow || isFlowError) return FALLBACK_STATUSES;
    return activeFlow.steps
      .filter((step: FlowStep) => !step.isSpecial)
      .sort((a: FlowStep, b: FlowStep) => a.order - b.order)
      .map((step: FlowStep) => step.name as Status);
  }, [activeFlow, isFlowError]);

  // Map from status name → FlowStep for quick label/order lookups
  const flowStepByStatus = React.useMemo((): Record<string, FlowStep> => {
    if (!activeFlow) return {};
    return Object.fromEntries(activeFlow.steps.map((s: FlowStep) => [s.name, s]));
  }, [activeFlow]);
  
  const { data: pricesData } = useQuery({
    queryKey: ['prices'],
    /* v8 ignore next 4 */
    queryFn: async () => {
      const res = await fetch('https://www.llm-prices.com/current-v1.json');
      return res.json();
    },
    staleTime: 1000 * 60 * 60 * 24
  });

  const [selectedItem, setSelectedItem] = useState<AgenFKItem | null>(null);

  // Fire card_opened when an existing item's modal is opened (id present = existing, not new)
  useEffect(() => {
    if (selectedItem?.id) {
      capture('card_opened', { itemType: selectedItem.type });
    }
  }, [selectedItem?.id]);

  const [navPath, setNavPath] = useState<NavItem[]>([]);

  const [searchQuery, setSearchTerm] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [searchMatches, setSearchMatches] = useState<AgenFKItem[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isIdeasCollapsed, setIsIdeasCollapsed] = useState(true);
  const [isArchiveCollapsed, setIsArchiveCollapsed] = useState(true);
  const [isBlockedCollapsed, setIsBlockedCollapsed] = useState(true);
  const [isPausedCollapsed, setIsPausedCollapsed] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'above' | 'below'>('below');
  const [isUserAction, setIsUserAction] = useState(false);
  const userActionTimerRef = React.useRef<any>(null);

  const triggerUserAction = () => {
    setIsUserAction(true);
    if (userActionTimerRef.current) clearTimeout(userActionTimerRef.current);
    userActionTimerRef.current = setTimeout(() => setIsUserAction(false), 5000);
  };

  const previousItemsRef = React.useRef(items);

  useEffect(() => {
    previousItemsRef.current = items;
  }, [items]);

  // Refs mirror state so handleDrop always reads current values (avoids stale closure in React 18)
  const dropTargetIdRef = React.useRef<string | null>(null);
  const dropPositionRef = React.useRef<'above' | 'below'>('below');

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Keep selected item in sync with fresh data
  useEffect(() => {
    if (selectedItem && items) {
      const updated = items.find((i: AgenFKItem) => i.id === selectedItem.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedItem)) {
        // Need to update asynchronously to avoid set-state-in-effect warning during render phase
        queueMicrotask(() => setSelectedItem(updated));
      }
    }
  }, [items, selectedItem]);
  
  // Keep a ref to isPinned so the WebSocket handler always reads the latest value
  const isPinnedRef = React.useRef(isPinned);
  useEffect(() => { isPinnedRef.current = isPinned; }, [isPinned]);

  // WebSocket setup
  /* v8 ignore start */
  useEffect(() => {
    const socket = io('http://localhost:3000');

    socket.on('connect', () => {
      console.log('%c[WS_CONNECT] %cConnected to AgenFK Brain', 'color: #6366f1; font-weight: bold', 'color: inherit');
    });

    socket.on('items_updated', () => {
      console.log('%c[WS_UPDATE] %cDatabase change detected. Refreshing UI...', 'color: #f59e0b; font-weight: bold', 'color: inherit');
      queryClient.invalidateQueries({ queryKey: ['items'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    });

    socket.on('flow:updated', ({ projectId }: { projectId?: string }) => {
      console.log('%c[WS_FLOW] %cFlow updated — refreshing columns...', 'color: #6366f1; font-weight: bold', 'color: inherit');
      queryClient.invalidateQueries({ queryKey: ['flow', projectId] });
    });

    socket.on('server_restarting', () => {
      console.log('%c[WS_RESTART] %cServer restarting after update — reloading in 4s...', 'color: #10b981; font-weight: bold', 'color: inherit');
      setTimeout(() => window.location.reload(), 4000);
    });

    socket.on('project_switched', ({ projectId }: { projectId: string }) => {
      if (isPinnedRef.current) {
        console.log('%c[WS_PROJECT] %cAuto-switch suppressed (project is pinned)', 'color: #f59e0b; font-weight: bold', 'color: inherit');
        return;
      }
      setSelectedProjectId(prev => {
        if (prev !== projectId) {
          console.log(`%c[WS_PROJECT] %cSwitching to active project: ${projectId}`, 'color: #10b981; font-weight: bold', 'color: inherit');
          setNavPath([]); // Only reset if project actually changed
          localStorage.setItem('agenfk_project_id', projectId);
        }
        return projectId;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient]);
  /* v8 ignore stop */

  const bulkUpdateMutation = useMutation({
    mutationFn: (variables: { items: { id: string, updates: Partial<AgenFKItem> }[] }) => 
      api.bulkUpdateItems(variables.items),
    onMutate: () => {
      triggerUserAction();
    },
    onSuccess: () => {
      // Don't invalidate immediately, rely on WebSocket to prevent bouncing
    }
  });

  const updateMutation = useMutation({
    mutationFn: (variables: { id: string, updates: Partial<AgenFKItem> }) => 
      api.updateItem(variables.id, variables.updates),
    onMutate: () => {
      triggerUserAction();
    },
    onSuccess: () => {
      // Don't invalidate immediately, rely on WebSocket
    }
  });

  const createMutation = useMutation({
    mutationFn: (variables: Partial<AgenFKItem>) => 
      api.createItem({ ...variables, projectId: selectedProjectId! } as any),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    }
  });

  const trashArchivedMutation = useMutation({
    mutationFn: (projectId: string) => api.trashArchivedItems(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    }
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, targetProjectId }: { id: string; targetProjectId: string }) =>
      api.moveItem(id, targetProjectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    }
  });

  const createProjectMutation = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      handleSelectProject(newProject.id);
      setIsCreatingProject(false);
      setNewProjectName('');
    }
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (selectedProjectId === deletedId) {
        setSelectedProjectId(null);
        localStorage.removeItem('agenfk_project_id');
      }
      setConfirmDeleteProjectId(null);
    }
  });

  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
    localStorage.setItem('agenfk_project_id', id);
    setNavPath([]);
    capture('project_switched');
  };

  const getItemsByStatus = (status: Status) => {
    if (!items) return [];

    let filtered = items.filter((i: AgenFKItem) => i.status === status);

    // Navigation Filtering
    if (navPath.length === 0) {
      filtered = filtered.filter((i: AgenFKItem) => !i.parentId);
    } else {
      const currentParent = navPath[navPath.length - 1];
      filtered = filtered.filter((i: AgenFKItem) => i.parentId === currentParent.id);
    }

    // Sort by sortOrder, then by createdAt for stable ordering
    filtered.sort((a: AgenFKItem, b: AgenFKItem) => {
      const aOrder = a.sortOrder;
      const bOrder = b.sortOrder;
      if (aOrder !== undefined && bOrder !== undefined) {
        if (aOrder !== bOrder) return aOrder - bOrder;
        // If sort orders are equal (e.g. during a mid-update collision), fall through to createdAt
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return filtered;
  };

  const handleDrillDown = (item: AgenFKItem) => {
    setNavPath([...navPath, { id: item.id, title: item.title, type: item.type }]);
  };

  const navigateTo = (index: number) => {
    if (index === -1) {
      setNavPath([]);
    } else {
      setNavPath(navPath.slice(0, index + 1));
    }
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('itemId', id);
    e.dataTransfer.setData('text/plain', id); // Fallback for wider browser support
    setDragId(id);
  };

  const handleDragEnd = () => {
    setDragId(null);
    setDropTargetId(null);
    dropTargetIdRef.current = null;
  };

  const handleCardDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
    dropTargetIdRef.current = targetId;
    dropPositionRef.current = pos;
    setDropTargetId(targetId);
    setDropPosition(pos);
  };


  const handleCardDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTargetId(null);
    }
  };

  const handleDrop = (e: React.DragEvent, status: Status) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData('itemId') || e.dataTransfer.getData('text/plain') || dragId;
    // Read from refs — always current, no stale-closure risk in React 18
    const currentDropTargetId = dropTargetIdRef.current;
    const currentDropPosition = dropPositionRef.current;
    
    // Clear refs and state immediately
    dropTargetIdRef.current = null;
    setDragId(null);
    setDropTargetId(null);
    
    if (!id || !items) return;

    const draggedItem = items.find((i: AgenFKItem) => i.id === id);
    if (!draggedItem) return;

    // Flow transition validation: block invalid moves when a flow is loaded
    if (activeFlow && draggedItem.status !== status) {
      const fromStep = flowStepByStatus[draggedItem.status];
      const toStep = flowStepByStatus[status];
      if (fromStep && toStep && !fromStep.isSpecial && !toStep.isSpecial) {
        const orderDiff = Math.abs(toStep.order - fromStep.order);
        if (orderDiff > 1) {
          // Invalid transition: revert (do nothing — drag is already cancelled visually)
          console.warn(`[FLOW] Blocked transition ${draggedItem.status} → ${status} (order diff ${orderDiff})`);
          return;
        }
      }
    }

    // Reorder within same column or move to specific position in another column
    if (currentDropTargetId && currentDropTargetId !== id) {
      const columnItemsBefore = getItemsByStatus(status);
      const columnItems = columnItemsBefore.filter((i: AgenFKItem) => i.id !== id);
      const targetIndex = columnItems.findIndex((i: AgenFKItem) => i.id === currentDropTargetId);
      
      if (targetIndex >= 0) {
        const insertIndex = currentDropPosition === 'above' ? targetIndex : targetIndex + 1;
        columnItems.splice(insertIndex, 0, draggedItem);
        
        // Update all items in the column to have correct sortOrder
        const bulkUpdates: {id: string, updates: Partial<AgenFKItem>}[] = [];
        columnItems.forEach((item: AgenFKItem, idx: number) => {
          const updates: Partial<AgenFKItem> = { sortOrder: idx };
          if (item.id === id && item.status !== status) {
            updates.status = status;
          }
          
          if (item.sortOrder !== idx || (item.id === id && item.status !== status)) {
            bulkUpdates.push({ id: item.id, updates });
          }
        });

        if (bulkUpdates.length > 0) {
          // Optimistic local UI update to prevent race conditions during sequential API calls
          queryClient.setQueryData(['items', selectedProjectId], (old: AgenFKItem[] | undefined) => {
            if (!old) return old;
            return old.map(item => {
              const update = bulkUpdates.find(u => u.id === item.id);
              if (update) return { ...item, ...update.updates };
              return item;
            });
          });

          // Fire bulk mutation (1 request = 1 refresh cycle)
          bulkUpdateMutation.mutate({ items: bulkUpdates });
        }
        return;
      }
    }

    // Cross-column or drop on empty space: update status (append to end of target column)
    if (draggedItem.status !== status) {
      const targetColumnItems = getItemsByStatus(status);
      const newSortOrder = targetColumnItems.length;

      // Optimistic local UI update
      queryClient.setQueryData(['items', selectedProjectId], (old: AgenFKItem[] | undefined) => {
        if (!old) return old;
        return old.map(item => item.id === id ? { ...item, status, sortOrder: newSortOrder } : item);
      });

      updateMutation.mutate({ id, updates: { status, sortOrder: newSortOrder } });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleColumnDragEnter = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      dropTargetIdRef.current = null;
      setDropTargetId(null);
    }
  };

  const handleArchiveColumn = (status: Status) => {
    const columnItems = getItemsByStatus(status);
    columnItems.forEach((item: AgenFKItem) => {
      updateMutation.mutate({ id: item.id, updates: { status: Status.ARCHIVED } });
    });
  };

  // Priority order for search results: active items first, archived last
  const statusPriority: Record<string, number> = {
    [Status.IN_PROGRESS]: 0,
    [Status.TODO]: 1,
    [Status.REVIEW]: 2,
    [Status.TEST]: 3,
    [Status.BLOCKED]: 4,
    [Status.PAUSED]: 5,
    [Status.IDEAS]: 6,
    [Status.DONE]: 7,
    [Status.ARCHIVED]: 8,
  };

  const navigateToMatch = (item: AgenFKItem) => {
    if (item.status === Status.IDEAS) setIsIdeasCollapsed(false);
    if (item.status === Status.ARCHIVED) setIsArchiveCollapsed(false);
    if (item.status === Status.BLOCKED) setIsBlockedCollapsed(false);
    if (item.status === Status.PAUSED) setIsPausedCollapsed(false);

    const chain: NavItem[] = [];
    let currentParentId = item.parentId;
    while (currentParentId) {
      const parent = items?.find((i: AgenFKItem) => i.id === currentParentId);
      if (parent) {
        chain.unshift({ id: parent.id, title: parent.title, type: parent.type });
        currentParentId = parent.parentId;
      } else break;
    }
    setNavPath(chain);
    setHighlightedId(item.id);

    setTimeout(() => {
      const element = document.getElementById(`card-${item.id}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, item.status === Status.ARCHIVED || chain.length > 0 ? 400 : 100);

    // Brief highlight: clear after 3s, cancelling any previous timer
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 3000);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !items) return;

    const term = searchQuery.toLowerCase();
    const matches = items
      .filter((i: AgenFKItem) =>
        i.id.toLowerCase().includes(term) ||
        i.title.toLowerCase().includes(term)
      )
      .sort((a: AgenFKItem, b: AgenFKItem) =>
        (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
      );

    if (matches.length > 0) {
      setSearchMatches(matches);
      setCurrentMatchIndex(0);
      navigateToMatch(matches[0]);
    } else {
      setSearchMatches([]);
      setCurrentMatchIndex(0);
      setSearchTerm('NOT FOUND');
      setTimeout(() => setSearchTerm(''), 1000);
    }
  };

  const handleSearchNav = (direction: 'prev' | 'next') => {
    if (searchMatches.length === 0) return;
    const newIndex = direction === 'next'
      ? (currentMatchIndex + 1) % searchMatches.length
      : (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
    setCurrentMatchIndex(newIndex);
    navigateToMatch(searchMatches[newIndex]);
  };

  const clearSearch = () => {
    setSearchMatches([]);
    setCurrentMatchIndex(0);
    setSearchTerm('');
    setHighlightedId(null);
  };

  if (isLoadingProjects) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
        <Loader2 className="h-10 w-10 animate-spin text-blue-500 mb-4" />
        <p className="font-medium">Connecting to AgenFK Brain...</p>
      </div>
    );
  }

  // Project Selection Screen
  if (!selectedProjectId || isCreatingProject) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
        <Logo size={64} className="mb-8" />
        <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-8 text-center">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Welcome to AgenFK</h2>
          <p className="text-slate-500 dark:text-slate-400 mb-8 text-sm">Select an existing project or create a new one to get started.</p>
          
          <div className="space-y-4">
            {projects && projects.length > 0 && !isCreatingProject && (
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest block text-left mb-2">Recent Projects</label>
                <div className="grid gap-2">
                  {projects.map(p => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 p-4 rounded-xl border border-slate-100 dark:border-slate-800 hover:border-indigo-500 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all group"
                    >
                      {confirmDeleteProjectId === p.id ? (
                        <>
                          <Trash2 className="text-red-500 shrink-0" size={20} />
                          <span className="flex-1 text-sm font-semibold text-red-600 dark:text-red-400">Delete "{p.name}"?</span>
                          <button
                            onClick={() => deleteProjectMutation.mutate(p.id)}
                            disabled={deleteProjectMutation.isPending}
                            className="text-xs font-bold px-3 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-all disabled:opacity-50"
                          >
                            {deleteProjectMutation.isPending ? <Loader2 className="animate-spin" size={12} /> : 'Delete'}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteProjectId(null)}
                            className="text-xs font-bold px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => handleSelectProject(p.id)}
                            className="flex flex-1 items-center gap-3 text-left"
                          >
                            <Briefcase className="text-slate-400 group-hover:text-indigo-500 shrink-0" size={20} />
                            <span className="font-semibold text-slate-700 dark:text-slate-200">{p.name}</span>
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteProjectId(p.id); }}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
                            title="Delete project"
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isCreatingProject ? (
              <div className="space-y-4 text-left">
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-2">Project Name</label>
                  <input 
                    autoFocus
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && newProjectName && createProjectMutation.mutate(newProjectName)}
                    placeholder="e.g. My Awesome App"
                    className="w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="flex gap-3 pt-2">
                  <button 
                    disabled={!newProjectName || createProjectMutation.isPending}
                    onClick={() => createProjectMutation.mutate(newProjectName)}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-all"
                  >
                    {createProjectMutation.isPending ? <Loader2 className="animate-spin mx-auto" size={20} /> : 'Create Project'}
                  </button>
                  <button 
                    onClick={() => setIsCreatingProject(false)}
                    className="px-6 py-3 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button 
                onClick={() => setIsCreatingProject(true)}
                className="w-full flex items-center justify-center gap-2 p-4 rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-indigo-500 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 font-bold transition-all mt-4"
              >
                <Plus size={20} />
                Create New Project
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const activeProject = projects?.find(p => p.id === selectedProjectId);

  // By using getItemsByStatus, we ensure the cycle time metrics exactly match 
  // the cards currently visible in the DONE column (respecting the navPath and type filters)
  const doneItems = getItemsByStatus(Status.DONE);
  const totalCycleMs = doneItems.reduce((acc: number, i: AgenFKItem) => acc + calculateCycleTimeMs(i), 0);
  const avgCycleMs = doneItems.length > 0 ? totalCycleMs / doneItems.length : 0;

  return (
    <div className="h-full min-h-screen bg-slate-100 dark:bg-slate-950 flex flex-col font-sans text-slate-900 dark:text-slate-100 transition-colors duration-300">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex flex-col gap-3 sticky top-0 z-10 shadow-sm dark:shadow-none">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <Logo size={32} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight transition-colors leading-none">AgenFK Dashboard</h1>
                <button
                  onClick={() => setIsWhatsNewOpen(true)}
                  title="What's new"
                  className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  <span className="text-[10px] font-mono font-bold text-slate-500 dark:text-slate-400 leading-none">
                    v{versionData?.version || '0.1.31'}
                  </span>
                  {isLoading && <Loader2 size={8} className="animate-spin text-slate-400" />}
                </button>
                <button
                  onClick={() => setIsReadmeOpen(true)}
                  title="View project README"
                  className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  <Book size={10} className="text-slate-500 dark:text-slate-400" />
                  <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 leading-none">
                    README
                  </span>
                </button>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest">
                  Project: <span className="text-indigo-600 dark:text-indigo-400">{activeProject?.name || 'Loading...'}</span>
                </p>
                <button
                  onClick={() => setSelectedProjectId(null)}
                  className="p-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-400 hover:text-indigo-600 transition-colors"
                  title="Switch Project"
                >
                  <FolderOpen size={11} />
                </button>
                {selectedProjectId && (
                  <button
                    onClick={togglePin}
                    title={isPinned ? 'Unpin project (allow auto-switching)' : 'Pin project (prevent auto-switching)'}
                    aria-label={isPinned ? 'Unpin project' : 'Pin project'}
                    data-testid="pin-project-btn"
                    className={clsx(
                      'p-0.5 rounded transition-colors',
                      isPinned
                        ? 'text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300'
                        : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400'
                    )}
                  >
                    {isPinned ? <Pin size={11} /> : <PinOff size={11} />}
                  </button>
                )}
              </div>
            </div>
          </div>

          <form onSubmit={handleSearch} className="relative flex-1 max-w-md hidden lg:flex items-center gap-1.5">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search Item ID or Name..."
                value={searchQuery}
                onChange={(e) => { setSearchTerm(e.target.value); if (!e.target.value.trim()) clearSearch(); }}
                onKeyDown={(e) => { if (e.key === 'Escape') clearSearch(); }}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-10 pr-4 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all dark:text-slate-200 shadow-inner"
              />
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
            {searchMatches.length > 0 && (
              <div className="flex items-center gap-0.5 text-xs font-medium text-slate-500 dark:text-slate-400 shrink-0">
                <span className="tabular-nums whitespace-nowrap">{currentMatchIndex + 1}/{searchMatches.length}</span>
                <button type="button" onClick={() => handleSearchNav('prev')} className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors" title="Previous match">
                  <ChevronUp size={14} />
                </button>
                <button type="button" onClick={() => handleSearchNav('next')} className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors" title="Next match">
                  <ChevronDown size={14} />
                </button>
                <button type="button" onClick={clearSearch} className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors ml-0.5" title="Clear search">
                  <X size={14} />
                </button>
              </div>
            )}
          </form>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-slate-100/50 dark:bg-slate-800/50 p-1 rounded-xl border border-slate-200/50 dark:border-slate-700/50">
              <JiraConnectionButton />

              {/* v8 ignore start */}
              {jiraStatus?.connected && selectedProjectId && (
                <button
                  onClick={() => setIsJiraImportOpen(true)}
                  data-testid="jira-import-btn"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-all shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
                >
                  <Download size={14} />
                  <span className="hidden xl:inline">Import</span>
                </button>
              )}
              {/* v8 ignore stop */}

              <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 hidden md:block" />

              {ghStatus?.configured && selectedProjectId && (
                <>
                  <a
                    href={`https://github.com/${ghStatus.owner}/${ghStatus.repo}/issues`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${ghStatus.owner}/${ghStatus.repo} Issues`}
                    className="flex items-center gap-1.5 px-2 py-1 bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border border-slate-200 dark:border-slate-700 hover:border-indigo-300 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-colors"
                  >
                    <svg width={12} height={12} viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                    <ExternalLink size={10} className="opacity-50" />
                  </a>
                  <button
                    onClick={() => setIsGitHubImportOpen(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-all shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
                    title="Import GitHub Issues"
                  >
                    <Download size={14} />
                    <span className="hidden xl:inline">Import</span>
                  </button>
                </>
              )}

              <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 hidden md:block" />

              <ReleaseReminder />

              {selectedProjectId && (
                <button
                  data-testid="manage-flow-btn"
                  onClick={() => setIsFlowEditorOpen(true)}
                  title="Manage Flow"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:text-indigo-600 transition-all shadow-sm border border-transparent hover:border-slate-200 dark:hover:border-slate-700"
                >
                  <GitBranch size={14} />
                  <span className="hidden xl:inline">Flow</span>
                </button>
              )}

              <button
                onClick={toggleTheme}
                className="p-1.5 hover:bg-white dark:hover:bg-slate-800 rounded-lg text-slate-500 hover:text-indigo-500 transition-all"
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>

            <button 
              onClick={() => setSelectedItem({ type: ItemType.TASK, status: Status.TODO, title: '', description: '', projectId: selectedProjectId! } as any)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 shadow-lg shadow-indigo-500/20 transition-all active:scale-95 whitespace-nowrap"
            >
              <Plus size={18} />
              <span>New Item</span>
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 dark:border-slate-800/50 pt-2 px-1">
          <div className="flex items-center gap-1.5 text-xs overflow-x-auto scrollbar-hide py-1">
            <button onClick={() => navigateTo(-1)} className={clsx("flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all whitespace-nowrap", navPath.length === 0 ? "bg-indigo-600 text-white font-bold shadow-md shadow-indigo-500/20" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800")}>
              <Home size={14} />
              <span className={clsx(navPath.length === 0 ? "inline" : "hidden sm:inline")}>Top Level</span>
            </button>
            {navPath.map((nav, index) => (
              <React.Fragment key={nav.id}>
                <ChevronRight size={14} className="text-slate-300 dark:text-slate-600 flex-shrink-0" />
                <button
                  /* v8 ignore start */
                  onClick={() => navigateTo(index)}
                  /* v8 ignore stop */
                  className={clsx("flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all whitespace-nowrap", index === navPath.length - 1 ? "bg-indigo-600 text-white font-bold shadow-md shadow-indigo-500/20" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800")}>
                  <span className={clsx("w-2 h-2 rounded-full", nav.type === ItemType.EPIC ? "bg-purple-300" : "bg-blue-300")}></span>
                  <span>{nav.title}</span>
                </button>
              </React.Fragment>
            ))}
          </div>

          <div className="flex items-center gap-4 shrink-0 pl-4 border-l border-slate-100 dark:border-slate-800/50 ml-2">
            {/* Tokens/Cost section hidden temporarily for algorithm enhancements
            <div className="flex flex-col items-end">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 leading-none mb-1">
                <Zap size={10} className="text-amber-500" />
                Tokens / Cost
                <button onClick={() => queryClient.invalidateQueries({ queryKey: ['items'] })} className="hover:text-indigo-600 transition-colors">
                  <Loader2 size={10} className={clsx(isLoading && "animate-spin")} />
                </button>
              </div>
              <div className="text-[11px] font-mono font-bold text-slate-600 dark:text-slate-300 leading-none">
                {items?.reduce((acc: number, i: any) => acc + (i.tokenUsage?.reduce((t: number, u: any) => t + u.input + u.output, 0) || 0), 0).toLocaleString()}
                {pricesData ? <span className="text-indigo-600 dark:text-indigo-400 ml-1">({formatCost(items?.reduce((acc: number, i: any) => acc + calculateCost(i.tokenUsage, pricesData), 0) || 0)})</span> : ''}
              </div>
            </div>
            */}

            <div className="flex flex-col items-end">
              <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 leading-none mb-1">
                <Clock size={10} className="text-emerald-500" />
                Cycle Total / Avg
              </div>
              <div className="text-[11px] font-mono font-bold text-slate-600 dark:text-slate-300 leading-none">
                {formatDuration(totalCycleMs)} <span className="text-emerald-600 dark:text-emerald-400 ml-1">/ {formatDuration(avgCycleMs)}</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-x-auto overflow-y-hidden p-4 bg-slate-50/50 dark:bg-slate-950/20 isolate relative z-0">
        <LayoutGroup id="board">
          <div className="flex flex-col md:flex-row gap-2 h-full w-full relative z-0">
            {/* Ideas Section — hidden in drill-down view */}
            {navPath.length === 0 && <div className={clsx("flex flex-col transition-all duration-300 h-full", !isIdeasCollapsed ? "w-64 shrink min-w-0" : "w-12 shrink-0")}>
              {isIdeasCollapsed ? (
                <button onClick={() => setIsIdeasCollapsed(false)} className="h-full w-full bg-indigo-50/50 dark:bg-indigo-900/10 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-indigo-100/50 dark:hover:bg-indigo-900/20 transition-colors group border border-dashed border-indigo-200 dark:border-indigo-900/30">
                  <Lightbulb size={16} className="text-indigo-400 group-hover:text-indigo-500 shrink-0" />
                  <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-indigo-400 shrink-0 mt-2">Ideas</span>
                  <span className="bg-white dark:bg-slate-800 text-indigo-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-indigo-100 dark:border-indigo-900/30 mt-auto">{items?.filter((i: AgenFKItem) => i.status === Status.IDEAS).length || 0}</span>
                </button>
              ) : (
                /* v8 ignore start */
                <div className="flex flex-col h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800"
                  onDrop={(e) => handleDrop(e, Status.IDEAS)}
                  onDragOver={handleDragOver}
                >
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-indigo-400 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsIdeasCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded"><ChevronLeft size={14} className="text-slate-500" /></button>
                      <Lightbulb size={14} className="text-indigo-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider text-xs">Ideas</h2>
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.IDEAS).length || 0}</span>
                  </div>
                  <div className={clsx("flex-1 pr-2 pb-2 flex flex-col gap-3 relative scrollbar-thin scrollbar-thumb-slate-200 overflow-y-auto overflow-x-hidden")} style={{ scrollbarGutter: 'stable' }}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {getItemsByStatus(Status.IDEAS).map((item: AgenFKItem) => (
                          <KanbanCard
                            key={item.id}
                            item={item}
                            items={items}
                            highlightedId={highlightedId}
                            dragId={dragId}
                            dropTargetId={dropTargetId}
                            dropPosition={dropPosition}
                            copiedId={copiedId}
                            pricesData={pricesData}
                            isUserAction={isUserAction}
                            onCardDragStart={handleDragStart}
                            onCardDragEnd={handleDragEnd}
                            onCardDragOver={handleCardDragOver}
                            onCardDragLeave={handleCardDragLeave}
                            onDoubleClick={() => setSelectedItem(item)}
                            onDrillDown={handleDrillDown}
                            onArchive={(id) => updateMutation.mutate({ id, updates: { status: Status.ARCHIVED } })}
                            projects={projects}
                            onMoveToProject={(id, targetProjectId) => moveMutation.mutate({ id, targetProjectId })}
                            onCopyId={handleCopyId}
                          />
                        ))}
                      </AnimatePresence>
                    {/* v8 ignore start */}
                    <button onClick={() => setSelectedItem({ type: ItemType.TASK, status: Status.IDEAS, title: '', description: '', projectId: selectedProjectId! } as any)} className="w-full py-1.5 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-slate-400 dark:text-slate-500 text-xs font-medium hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-500 dark:hover:text-indigo-400 transition-all flex items-center justify-center gap-1.5">
                      <Plus size={14} /> Add idea
                    </button>
                    {/* v8 ignore stop */}
                  </div>
                </div>
                /* v8 ignore stop */
              )}
            </div>}

          {isLoadingFlow && !activeFlow && (
            <div className="flex items-center justify-center flex-1 min-h-[200px]">
              <Loader2 size={24} className="animate-spin text-indigo-400" />
            </div>
          )}

          {(!isLoadingFlow || activeFlow) && mainColumnStatuses.map(status => {
            const flowStep = flowStepByStatus[status];
            const columnLabel = flowStep ? (flowStep.label || flowStep.name) : status.replace(/_/g, ' ');
            return (
            <div key={status} className="flex flex-col w-full md:flex-1 md:min-w-[180px] h-full min-h-[300px] md:min-h-0" onDrop={(e) => handleDrop(e, status as Status)} onDragOver={handleDragOver} onDragEnter={handleColumnDragEnter}>
              <div className={clsx("flex items-center justify-between mb-3 px-1 border-t-4 pt-2", statusBorderColors[status as Status] ?? "border-t-slate-400")}>
                <div className="flex items-center gap-2">
                  <div className={clsx(
                    "p-1 rounded-md",
                    status === Status.TEST ? "text-purple-500 bg-purple-50 dark:bg-purple-900/20" :
                    status === Status.IN_PROGRESS ? "text-blue-500 bg-blue-50 dark:bg-blue-900/20" :
                    status === Status.REVIEW ? "text-amber-500 bg-amber-50 dark:bg-amber-900/20" :
                    status === Status.DONE ? "text-emerald-500 bg-emerald-50 dark:bg-emerald-900/20" :
                    status === Status.BLOCKED ? "text-red-500 bg-red-50 dark:bg-red-900/20" :
                    "text-slate-500 bg-slate-50 dark:bg-slate-800"
                  )}>
                    {statusIcons[status as Status] ?? <Briefcase size={14} />}
                  </div>
                  <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider">{columnLabel}</h2>
                  <button onClick={() => handleArchiveColumn(status as Status)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded text-slate-400 dark:text-slate-500 transition-colors" title="Archive Column">
                    <Archive size={12} />
                  </button>
                </div>
                <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">
                  {getItemsByStatus(status as Status).length}
                </span>
              </div>

              <div className={clsx("flex-1 px-3 pb-10 flex flex-col gap-3 relative scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 overflow-y-auto overflow-x-hidden")} style={{ scrollbarGutter: 'stable' }}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {getItemsByStatus(status as Status).map((item: AgenFKItem) => (
                      <CardAnimationWrapper key={`anim-${item.id}`} enabled={easterEggsEnabled} itemId={item.id} status={item.status}>
                      <KanbanCard
                        key={item.id}
                        item={item}
                        items={items}
                        highlightedId={highlightedId}
                        dragId={dragId}
                        dropTargetId={dropTargetId}
                        dropPosition={dropPosition}
                        copiedId={copiedId}
                        pricesData={pricesData}
                        isUserAction={isUserAction}
                        onCardDragStart={handleDragStart}
                        onCardDragEnd={handleDragEnd}
                        onCardDragOver={handleCardDragOver}
                        onCardDragLeave={handleCardDragLeave}
                        onDoubleClick={() => setSelectedItem(item)}
                        onDrillDown={handleDrillDown}
                        /* v8 ignore start */
                        onArchive={(id) => updateMutation.mutate({ id, updates: { status: Status.ARCHIVED } })}
                        /* v8 ignore stop */
                        projects={projects}
                        onMoveToProject={(id, targetProjectId) => moveMutation.mutate({ id, targetProjectId })}
                        onCopyId={handleCopyId}
                        disableLayoutAnimation={easterEggsEnabled}
                      />
                      </CardAnimationWrapper>
                    ))}
                  </AnimatePresence>
                <button onClick={() => setSelectedItem({ type: ItemType.TASK, status: status as Status, title: '', description: '', projectId: selectedProjectId! } as any)} className="w-full py-2 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-slate-400 dark:text-slate-500 text-sm font-medium hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-all flex items-center justify-center gap-2">
                  <Plus size={16} /> Add {columnLabel.toLowerCase()}
                </button>
              </div>
            </div>
            );
          })}

          {/* Paused + Blocked + Archived — hidden in drill-down view */}
          {navPath.length === 0 && (
            <>
              {/* Expanded sections render as independent columns side-by-side with main board */}
              {!isPausedCollapsed && (
                <div className="flex flex-col w-full md:flex-1 md:min-w-[180px] h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800 transition-all duration-300" onDrop={(e) => handleDrop(e, Status.PAUSED)} onDragOver={handleDragOver}>
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-orange-400 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsPausedCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors" title="Collapse Column"><ChevronRight size={14} className="text-slate-500" /></button>
                      <Pause size={14} className="text-orange-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">Paused</h2>
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.PAUSED).length || 0}</span>
                  </div>
                  <div className={clsx("flex-1 pr-2 pb-2 flex flex-col gap-3 relative scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 overflow-y-auto overflow-x-hidden")} style={{ scrollbarGutter: 'stable' }}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {getItemsByStatus(Status.PAUSED).map((item: AgenFKItem) => (
                          <KanbanCard
                            key={item.id}
                            item={item}
                            items={items}
                            highlightedId={highlightedId}
                            dragId={dragId}
                            dropTargetId={dropTargetId}
                            dropPosition={dropPosition}
                            copiedId={copiedId}
                            pricesData={pricesData}
                            isUserAction={isUserAction}
                            onCardDragStart={handleDragStart}
                            onCardDragEnd={handleDragEnd}
                            onCardDragOver={handleCardDragOver}
                            onCardDragLeave={handleCardDragLeave}
                            onDoubleClick={() => setSelectedItem(item)}
                            onDrillDown={handleDrillDown}
                            onArchive={(id) => updateMutation.mutate({ id, updates: { status: Status.ARCHIVED } })}
                            projects={projects}
                            onMoveToProject={(id, targetProjectId) => moveMutation.mutate({ id, targetProjectId })}
                            onCopyId={handleCopyId}
                            disableLayoutAnimation={easterEggsEnabled}
                          />
                        ))}
                      </AnimatePresence>
                  </div>
                </div>
              )}

              {!isBlockedCollapsed && (
                <div className="flex flex-col w-full md:flex-1 md:min-w-[180px] h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800 transition-all duration-300" onDrop={(e) => handleDrop(e, Status.BLOCKED)} onDragOver={handleDragOver}>
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-red-400 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsBlockedCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors" title="Collapse Column"><ChevronRight size={14} className="text-slate-500" /></button>
                      <AlertCircle size={14} className="text-red-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">Blocked</h2>
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.BLOCKED).length || 0}</span>
                  </div>
                  <div className={clsx("flex-1 pr-2 pb-2 flex flex-col gap-3 relative scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 overflow-y-auto overflow-x-hidden")} style={{ scrollbarGutter: 'stable' }}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {getItemsByStatus(Status.BLOCKED).map((item: AgenFKItem) => (
                          <KanbanCard
                            key={item.id}
                            item={item}
                            items={items}
                            highlightedId={highlightedId}
                            dragId={dragId}
                            dropTargetId={dropTargetId}
                            dropPosition={dropPosition}
                            copiedId={copiedId}
                            pricesData={pricesData}
                            isUserAction={isUserAction}
                            onCardDragStart={handleDragStart}
                            onCardDragEnd={handleDragEnd}
                            onCardDragOver={handleCardDragOver}
                            onCardDragLeave={handleCardDragLeave}
                            onDoubleClick={() => setSelectedItem(item)}
                            onDrillDown={handleDrillDown}
                            onArchive={(id) => updateMutation.mutate({ id, updates: { status: Status.ARCHIVED } })}
                            projects={projects}
                            onMoveToProject={(id, targetProjectId) => moveMutation.mutate({ id, targetProjectId })}
                            onCopyId={handleCopyId}
                            disableLayoutAnimation={easterEggsEnabled}
                          />
                        ))}
                      </AnimatePresence>
                    <button onClick={() => setSelectedItem({ type: ItemType.TASK, status: Status.BLOCKED, title: '', description: '', projectId: selectedProjectId! } as any)} className="w-full py-2 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-slate-400 dark:text-slate-500 text-xs font-medium hover:border-red-300 dark:hover:border-red-700 hover:text-red-500 dark:hover:text-red-400 transition-all flex items-center justify-center gap-2 mt-2">
                      <Plus size={16} /> Add blocked
                    </button>
                  </div>
                </div>
              )}

              {!isArchiveCollapsed && (
                <div className="flex flex-col w-full md:flex-1 md:min-w-[180px] h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800 transition-all duration-300" onDrop={(e) => handleDrop(e, Status.ARCHIVED)} onDragOver={handleDragOver}>
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-slate-300 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsArchiveCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors" title="Collapse Column"><ChevronRight size={14} className="text-slate-500" /></button>
                      <Archive size={14} className="text-slate-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-xs uppercase tracking-wider">Archived</h2>
                      {items?.some((i: AgenFKItem) => i.status === Status.ARCHIVED) && (
                        <button
                          onClick={() => {
                            if (window.confirm('Move all archived items to trash?')) {
                              trashArchivedMutation.mutate(selectedProjectId!);
                            }
                          }}
                          className="p-1 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded text-slate-400 hover:text-rose-500 transition-colors"
                          title="Trash All Archived"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).length || 0}</span>
                  </div>
                  <div className={clsx("flex-1 pr-2 pb-2 flex flex-col gap-3 relative scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800 overflow-y-auto overflow-x-hidden")} style={{ scrollbarGutter: 'stable' }}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).map((item: AgenFKItem) => (
                        <KanbanCard
                          key={item.id}
                          item={item}
                          items={items}
                          highlightedId={highlightedId}
                          dragId={dragId}
                          dropTargetId={dropTargetId}
                          dropPosition={dropPosition}
                          copiedId={copiedId}
                          pricesData={pricesData}
                          isUserAction={isUserAction}
                          onCardDragStart={handleDragStart}
                          onCardDragEnd={handleDragEnd}
                          onCardDragOver={handleCardDragOver}
                          onCardDragLeave={handleCardDragLeave}
                          onDoubleClick={() => setSelectedItem(item)}
                          onDrillDown={handleDrillDown}
                          onArchive={(id) => updateMutation.mutate({ id, updates: { status: item.previousStatus || Status.TODO } })}
                          projects={projects}
                          onMoveToProject={(id, targetProjectId) => moveMutation.mutate({ id, targetProjectId })}
                          onCopyId={handleCopyId}
                          disableLayoutAnimation={easterEggsEnabled}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              )}

              {/* Collapsed sections stacked vertically in a narrow column on the right */}
              {(isPausedCollapsed || isBlockedCollapsed || isArchiveCollapsed) && (
                <div className="w-12 shrink-0 flex flex-col gap-2 h-full">
                  {isPausedCollapsed && (
                    <button
                      onClick={() => setIsPausedCollapsed(false)}
                      className="flex-1 w-full bg-orange-50/50 dark:bg-orange-900/10 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-orange-100/50 dark:hover:bg-orange-900/20 transition-colors group border border-dashed border-orange-200 dark:border-orange-900/30"
                    >
                      <Pause size={16} className="text-orange-400 group-hover:text-orange-500 shrink-0" />
                      <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-orange-400 shrink-0 mt-2">Paused</span>
                      <span className="bg-white dark:bg-slate-800 text-orange-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-orange-100 dark:border-orange-900/30 mt-auto">{items?.filter((i: AgenFKItem) => i.status === Status.PAUSED).length || 0}</span>
                    </button>
                  )}
                  {isBlockedCollapsed && (
                    <button
                      onClick={() => setIsBlockedCollapsed(false)}
                      className="flex-1 w-full bg-red-50/50 dark:bg-red-900/10 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-red-100/50 dark:hover:bg-red-900/20 transition-colors group border border-dashed border-red-200 dark:border-red-900/30"
                    >
                      <AlertCircle size={16} className="text-red-400 group-hover:text-red-500 shrink-0" />
                      <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-red-400 shrink-0 mt-2">Blocked</span>
                      <span className="bg-white dark:bg-slate-800 text-red-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-red-100 dark:border-red-900/30 mt-auto">{items?.filter((i: AgenFKItem) => i.status === Status.BLOCKED).length || 0}</span>
                    </button>
                  )}
                  {isArchiveCollapsed && (
                    <button onClick={() => setIsArchiveCollapsed(false)} className="flex-1 w-full bg-slate-200/50 dark:bg-slate-900/50 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-slate-300 dark:hover:bg-slate-800 transition-colors group border border-dashed border-slate-300 dark:border-slate-800">
                      <Archive size={16} className="text-slate-500 group-hover:text-indigo-600 shrink-0" />
                      <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-slate-500 shrink-0 mt-2">Archived</span>
                      <span className="bg-white dark:bg-slate-800 text-slate-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-slate-100 dark:border-slate-700 mt-auto">{items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).length || 0}</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          </div>
        </LayoutGroup>
      </main>

      {selectedItem && (
        <CardDetailModal 
          item={selectedItem} 
          allItems={items || []}
          pricesData={pricesData}
          onClose={() => setSelectedItem(null)} 
          onSelectItem={setSelectedItem}
          /* v8 ignore start */
          onAddItem={async (title, type, status, description) => {
            await createMutation.mutateAsync({
              title,
              type,
              parentId: selectedItem.id,
              status: status || Status.TODO,
              description: description || '',
              projectId: selectedProjectId!
            });
          }}
          onDeleteItem={async (id) => {
            await deleteMutation.mutateAsync(id);
          }}
          onUpdateItem={async (id, updates) => {
            await updateMutation.mutateAsync({ id, updates });
          }}
          /* v8 ignore stop */
        />
      )}

      {/* v8 ignore start */}
      {isJiraImportOpen && selectedProjectId && (
        <JiraImportModal
          open={isJiraImportOpen}
          onClose={() => setIsJiraImportOpen(false)}
          projectId={selectedProjectId}
        />
      )}
      {isGitHubImportOpen && selectedProjectId && (
        <GitHubImportModal
          open={isGitHubImportOpen}
          onClose={() => setIsGitHubImportOpen(false)}
          projectId={selectedProjectId}
        />
      )}
      {/* v8 ignore stop */}

      <WhatsNewModal isOpen={isWhatsNewOpen} onClose={() => setIsWhatsNewOpen(false)} />
      <ReadmeModal isOpen={isReadmeOpen} onClose={() => setIsReadmeOpen(false)} />

      {isFlowEditorOpen && selectedProjectId && (
        <FlowEditorModal
          isOpen={isFlowEditorOpen}
          onClose={() => setIsFlowEditorOpen(false)}
          projectId={selectedProjectId}
          activeFlowId={activeFlow?.id}
        />
      )}

    </div>
  );
};
