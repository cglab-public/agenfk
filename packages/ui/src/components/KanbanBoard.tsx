import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AgenFKItem, ItemType, Status, Project } from '../types';
import { clsx } from 'clsx';
import { 
  Plus, Loader2, AlertCircle, Layout, Tag, 
  AlignLeft, Zap, ChevronRight, Home, ArrowRight,
  Sun, Moon, Search, Archive, ArchiveRestore, ChevronLeft,
  FolderOpen, Briefcase, Clock, FlaskConical, ShieldCheck,
  Copy, Check
} from 'lucide-react';
import { io } from 'socket.io-client';
import { CardDetailModal } from './CardDetailModal';
import { useTheme } from '../ThemeContext';
import { Logo } from './Logo';
import { calculateCost, formatCost } from '../utils';

const statuses = [
  Status.TODO,
  Status.IN_PROGRESS,
  Status.REVIEW,
  Status.TEST,
  Status.DONE
];

interface NavItem {
  id: string;
  title: string;
  type: ItemType;
}

const statusBorderColors: Record<Status, string> = {
  [Status.TODO]: "border-t-slate-400",
  [Status.IN_PROGRESS]: "border-t-blue-500",
  [Status.TEST]: "border-t-purple-500",
  [Status.REVIEW]: "border-t-amber-500",
  [Status.DONE]: "border-t-emerald-500",
  [Status.BLOCKED]: "border-t-red-500",
  [Status.ARCHIVED]: "border-t-gray-300",
};

export const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const statusIcons: Record<Status, React.ReactNode> = {
  [Status.TODO]: <Plus size={14} />,
  [Status.IN_PROGRESS]: <Zap size={14} />,
  [Status.TEST]: <FlaskConical size={14} />,
  [Status.REVIEW]: <ShieldCheck size={14} />,
  [Status.DONE]: <ChevronRight size={14} />,
  [Status.BLOCKED]: <AlertCircle size={14} />,
  [Status.ARCHIVED]: <Archive size={14} />,
};

export const KanbanBoard: React.FC = () => {
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  
  // Project State
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => localStorage.getItem('agenfk_project_id'));
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  const { data: projects, isLoading: isLoadingProjects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.listProjects()
  });

  // Clear stale localStorage project ID if it no longer exists in the DB
  useEffect(() => {
    if (isLoadingProjects || !projects) return;
    if (selectedProjectId && !projects.find(p => p.id === selectedProjectId)) {
      const fallback = projects.length === 1 ? projects[0].id : null;
      setSelectedProjectId(fallback);
      if (fallback) {
        localStorage.setItem('agenfk_project_id', fallback);
      } else {
        localStorage.removeItem('agenfk_project_id');
      }
    }
  }, [projects, isLoadingProjects]);

  const { data: items, isLoading, error } = useQuery({ 
    queryKey: ['items', selectedProjectId], 
    queryFn: () => api.listItems({ includeArchived: true, projectId: selectedProjectId || undefined }),
    enabled: !!selectedProjectId
  });
  
  const { data: pricesData } = useQuery({
    queryKey: ['prices'],
    queryFn: async () => {
      const res = await fetch('https://www.llm-prices.com/current-v1.json');
      return res.json();
    },
    staleTime: 1000 * 60 * 60 * 24
  });

  const [selectedItem, setSelectedItem] = useState<AgenFKItem | null>(null);
  const [navPath, setNavPath] = useState<NavItem[]>([]);
  const [selectedItemType, setSelectedItemType] = useState<ItemType | 'ALL'>('ALL');
  const [searchQuery, setSearchTerm] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [isArchiveCollapsed, setIsArchiveCollapsed] = useState(true);
  const [isBlockedCollapsed, setIsBlockedCollapsed] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
        setSelectedItem(updated);
      }
    }
  }, [items, selectedItem]);
  
  // WebSocket setup
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

    socket.on('project_switched', ({ projectId }: { projectId: string }) => {
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

  const updateMutation = useMutation({
    mutationFn: (variables: { id: string, updates: Partial<AgenFKItem> }) => 
      api.updateItem(variables.id, variables.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
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

  const createProjectMutation = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: (newProject) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      handleSelectProject(newProject.id);
      setIsCreatingProject(false);
      setNewProjectName('');
    }
  });

  const handleSelectProject = (id: string) => {
    setSelectedProjectId(id);
    localStorage.setItem('agenfk_project_id', id);
    setNavPath([]);
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

    // Type Filtering
    if (selectedItemType !== 'ALL') {
      filtered = filtered.filter((i: AgenFKItem) => i.type === selectedItemType);
    }

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
    e.dataTransfer.setData('itemId', id);
  };

  const handleDrop = (e: React.DragEvent, status: Status) => {
    const id = e.dataTransfer.getData('itemId');
    if (id) {
      updateMutation.mutate({ id, updates: { status } });
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleArchiveColumn = (status: Status) => {
    const columnItems = getItemsByStatus(status);
    columnItems.forEach((item: AgenFKItem) => {
      updateMutation.mutate({ id: item.id, updates: { status: Status.ARCHIVED } });
    });
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !items) return;

    const term = searchQuery.toLowerCase();
    const found = items.find((i: AgenFKItem) => 
      i.id.toLowerCase().includes(term) || 
      i.title.toLowerCase().includes(term)
    );

    if (found) {
      if (found.status === Status.ARCHIVED) {
        setIsArchiveCollapsed(false);
      }
      if (found.status === Status.BLOCKED) {
        setIsBlockedCollapsed(false);
      }

      const chain: NavItem[] = [];
      let currentParentId = found.parentId;
      while (currentParentId) {
        const parent = items.find((i: AgenFKItem) => i.id === currentParentId);
        if (parent) {
          chain.unshift({ id: parent.id, title: parent.title, type: parent.type });
          currentParentId = parent.parentId;
        } else break;
      }
      setNavPath(chain);
      setSelectedItemType('ALL');
      setHighlightedId(found.id);
      setSearchTerm('');
      
      // Give DOM time to update if we expanded archive or changed levels
      setTimeout(() => {
        const element = document.getElementById(`card-${found.id}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, found.status === Status.ARCHIVED || chain.length > 0 ? 400 : 100);
      
      setTimeout(() => setHighlightedId(null), 3000);
    } else {
      // Temporary visual feedback for not found
      setSearchTerm('NOT FOUND');
      setTimeout(() => setSearchTerm(''), 1000);
    }
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
                    <button 
                      key={p.id}
                      onClick={() => handleSelectProject(p.id)}
                      className="flex items-center gap-3 p-4 rounded-xl border border-slate-100 dark:border-slate-800 hover:border-indigo-500 dark:hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all text-left group"
                    >
                      <Briefcase className="text-slate-400 group-hover:text-indigo-500" size={20} />
                      <span className="font-semibold text-slate-700 dark:text-slate-200">{p.name}</span>
                    </button>
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

  const doneItems = items?.filter((i: AgenFKItem) => i.status === Status.DONE) || [];
  const totalCycleMs = doneItems.reduce((acc: number, i: AgenFKItem) => acc + (new Date(i.updatedAt).getTime() - new Date(i.createdAt).getTime()), 0);
  const avgCycleMs = doneItems.length > 0 ? totalCycleMs / doneItems.length : 0;

  return (
    <div className="h-full min-h-screen bg-slate-100 dark:bg-slate-950 flex flex-col font-sans text-slate-900 dark:text-slate-100 transition-colors duration-300">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex flex-col gap-4 sticky top-0 z-10 shadow-sm dark:shadow-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo size={32} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight transition-colors leading-none">AgenFK Dashboard</h1>
                <button 
                  onClick={() => setSelectedProjectId(null)}
                  className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-400 hover:text-indigo-600 transition-colors"
                  title="Switch Project"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-1">
                Project: <span className="text-indigo-600 dark:text-indigo-400">{activeProject?.name || 'Loading...'}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <form onSubmit={handleSearch} className="relative hidden md:block">
              <input 
                type="text"
                placeholder="Search Item ID or Name..."
                value={searchQuery}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg pl-9 pr-3 py-1.5 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all w-64 dark:text-slate-200"
              />
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            </form>

            <button onClick={toggleTheme} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-500 border border-slate-200 dark:border-slate-700 shadow-sm transition-colors">
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="pl-2 pr-1 border-r border-slate-200 dark:border-slate-700">
                <Tag size={12} className="text-slate-400" />
              </div>
              <select 
                value={selectedItemType} 
                onChange={(e) => setSelectedItemType(e.target.value as ItemType | 'ALL')}
                className="bg-transparent text-xs font-bold text-slate-600 dark:text-slate-300 focus:outline-none px-2 py-1 cursor-pointer"
              >
                <option value="ALL">All Types</option>
                {Object.values(ItemType).map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>

            <div className="text-right hidden sm:block border-l border-slate-200 dark:border-slate-700 pl-4">
              <div className="text-xs text-slate-400 dark:text-slate-500 font-medium uppercase tracking-tight flex items-center gap-2 justify-end">
                Tokens / Cost
                <button onClick={() => queryClient.invalidateQueries({ queryKey: ['items'] })} className="hover:text-indigo-600 transition-colors">
                  <Loader2 size={12} className={clsx(isLoading && "animate-spin")} />
                </button>
              </div>
              <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400 transition-colors">
                {items?.reduce((acc: number, i: any) => acc + (i.tokenUsage?.reduce((t: number, u: any) => t + u.input + u.output, 0) || 0), 0).toLocaleString()}
                {pricesData ? ` / ${formatCost(items?.reduce((acc: number, i: any) => acc + calculateCost(i.tokenUsage, pricesData), 0) || 0)}` : ''}
              </div>
            </div>

            <div className="text-right hidden sm:block border-l border-slate-200 dark:border-slate-700 pl-4">
              <div className="text-xs text-slate-400 dark:text-slate-500 font-medium uppercase tracking-tight flex items-center gap-2 justify-end">
                Cycle Total / Avg
              </div>
              <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400 transition-colors">
                {formatDuration(totalCycleMs)} / {formatDuration(avgCycleMs)}
              </div>
            </div>
            <button 
              onClick={() => setSelectedItem({ type: ItemType.TASK, status: Status.TODO, title: '', description: '', projectId: selectedProjectId! } as any)}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 shadow-sm transition-all active:scale-95"
            >
              <Plus size={16} />
              <span>New Item</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm overflow-x-auto py-1 border-t border-slate-50 dark:border-slate-800 pt-3 scrollbar-hide">
          <button onClick={() => navigateTo(-1)} className={clsx("flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors whitespace-nowrap", navPath.length === 0 ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-bold" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800")}>
            <Home size={14} />
            <span>Top Level</span>
          </button>
          {navPath.map((nav, index) => (
            <React.Fragment key={nav.id}>
              <ChevronRight size={14} className="text-slate-300 dark:text-slate-600 flex-shrink-0" />
              <button onClick={() => navigateTo(index)} className={clsx("flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors whitespace-nowrap", index === navPath.length - 1 ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-bold" : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800")}>
                <span className={clsx("w-2 h-2 rounded-full", nav.type === ItemType.EPIC ? "bg-purple-400" : "bg-blue-400")}></span>
                <span>{nav.title}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-x-auto p-4 md:p-6">
        <div className="flex flex-col md:flex-row gap-6 h-full">
          {statuses.map(status => (
            <div key={status} className="flex flex-col w-full md:w-80 h-full min-h-[300px] md:min-h-0" onDrop={(e) => handleDrop(e, status as Status)} onDragOver={handleDragOver}>
              <div className={clsx("flex items-center justify-between mb-3 px-1 border-t-4 pt-2", statusBorderColors[status as Status])}>
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
                    {statusIcons[status as Status]}
                  </div>
                  <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider">{status.replace('_', ' ')}</h2>
                  <button onClick={() => handleArchiveColumn(status as Status)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded text-slate-400 dark:text-slate-500 transition-colors" title="Archive Column">
                    <Archive size={12} />
                  </button>
                </div>
                <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">
                  {getItemsByStatus(status as Status).length}
                </span>
              </div>
              
              <div className="flex-1 overflow-y-auto px-3 pb-10 space-y-3 scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800">
                {getItemsByStatus(status as Status).map((item: AgenFKItem) => (
                  <div 
                    key={item.id} 
                    id={`card-${item.id}`} 
                    className={clsx(
                      "group bg-white dark:bg-slate-900 rounded-xl p-4 shadow-sm border border-slate-200 dark:border-slate-800 cursor-move hover:shadow-md dark:hover:shadow-indigo-900/10 hover:border-indigo-200 dark:hover:border-indigo-800 transition-all duration-200 relative", 
                      highlightedId === item.id && "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)] z-10 border-indigo-500 dark:border-indigo-500 bg-indigo-50/50 dark:bg-indigo-900/30"
                    )} 
                    draggable 
                    onDragStart={(e) => handleDragStart(e, item.id)} 
                    onDoubleClick={() => setSelectedItem(item)}
                  >
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-2">
                        <span className={clsx("text-[10px] font-bold px-2.5 py-1 rounded-md border uppercase tracking-wider flex items-center gap-1.5", item.type === ItemType.EPIC ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800" : item.type === ItemType.STORY ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800" : item.type === ItemType.TASK ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" : "bg-rose-50 dark:bg-rose-900/20 text-red-700 dark:text-red-300 border-red-100 dark:border-red-800")}>
                          {item.type}
                        </span>
                        {(item.type === ItemType.EPIC || item.type === ItemType.STORY) && items?.some((i: AgenFKItem) => i.parentId === item.id) && (
                          <button onClick={(e) => { e.stopPropagation(); handleDrillDown(item); }} className="bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800 text-indigo-600 dark:text-indigo-400 px-2 py-1 rounded text-[10px] font-bold uppercase flex items-center gap-1 transition-colors">
                            Drill <ArrowRight size={10} />
                          </button>
                        )}
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); updateMutation.mutate({ id: item.id, updates: { status: Status.ARCHIVED } }); }} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
                        <Archive size={12} />
                      </button>
                    </div>
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm leading-snug mb-2 group-hover:text-indigo-700 dark:group-hover:text-indigo-400 transition-colors">{item.title}</h3>
                    {item.description && <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-3">{item.description}</p>}
                    
                    {(item.type === ItemType.EPIC || item.type === ItemType.STORY) && (
                      <div className="mb-3">
                        {(() => {
                          const subitems = items?.filter((i: AgenFKItem) => i.parentId === item.id) || [];
                          if (subitems.length === 0) return null;
                          const progress = Math.round((subitems.filter((i: AgenFKItem) => i.status === Status.DONE).length / subitems.length) * 100);
                          return (
                            <div className="space-y-1.5">
                              <div className="flex justify-between items-center text-[9px] font-bold text-slate-400 uppercase tracking-tighter">
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

                    <div className="flex items-center justify-between pt-3 border-t border-slate-50 dark:border-slate-800 mt-auto text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                      <div className="flex items-center gap-2">
                        <div 
                          className="flex items-center gap-1.5 group/id cursor-pointer" 
                          onClick={(e) => { e.stopPropagation(); handleCopyId(item.id); }}
                          title="Copy Full ID"
                        >
                          <span className="group-hover/id:text-indigo-500 transition-colors">#{item.id.substring(0, 4)}</span>
                          <div className="opacity-0 group-hover/id:opacity-100 transition-opacity">
                            {copiedId === item.id ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 font-medium text-slate-500 dark:text-slate-400">
                          <Clock size={10} />
                          {item.status === Status.DONE 
                            ? formatDuration(new Date(item.updatedAt).getTime() - new Date(item.createdAt).getTime())
                            : formatDuration(Date.now() - new Date(item.createdAt).getTime())
                          }
                        </div>
                      </div>
                      {item.tokenUsage && item.tokenUsage.length > 0 && (
                        <div className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded-full">
                          <Zap size={10} className="fill-amber-600" />
                          {item.tokenUsage.reduce((acc, curr) => acc + curr.input + curr.output, 0).toLocaleString()}
                          {pricesData ? ` (${formatCost(calculateCost(item.tokenUsage, pricesData))})` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <button onClick={() => setSelectedItem({ type: ItemType.TASK, status: status as Status, title: '', description: '', projectId: selectedProjectId! } as any)} className="w-full py-2 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-slate-400 dark:text-slate-500 text-sm font-medium hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-all flex items-center justify-center gap-2">
                  <Plus size={16} /> Add {status.toLowerCase()}
                </button>
              </div>
            </div>
          ))}

          <div className={clsx("flex flex-col gap-4 transition-all duration-300 h-full", (!isArchiveCollapsed || !isBlockedCollapsed) ? "w-80 shrink-0" : "w-12 shrink-0")}>
            {/* Blocked Section */}
            <div className={clsx("flex flex-col transition-all duration-300", isBlockedCollapsed ? (isArchiveCollapsed ? "flex-1" : "h-12 shrink-0") : (isArchiveCollapsed ? "flex-1 h-full" : "flex-1 h-1/2"))}>
              {isBlockedCollapsed ? (
                <button onClick={() => setIsBlockedCollapsed(false)} className="h-full w-full bg-red-50/50 dark:bg-red-900/10 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-red-100/50 dark:hover:bg-red-900/20 transition-colors group border border-dashed border-red-200 dark:border-red-900/30">
                  <AlertCircle size={16} className="text-red-400 group-hover:text-red-500 shrink-0" />
                  {isArchiveCollapsed && <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-red-400 shrink-0 mt-2">Blocked</span>}
                  <span className={clsx("bg-white dark:bg-slate-800 text-red-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-red-100 dark:border-red-900/30", isArchiveCollapsed && "mt-auto")}>{items?.filter((i: AgenFKItem) => i.status === Status.BLOCKED).length || 0}</span>
                </button>
              ) : (
                <div className="flex flex-col h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800" onDrop={(e) => handleDrop(e, Status.BLOCKED)} onDragOver={handleDragOver}>
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-red-400 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsBlockedCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded"><ChevronLeft size={14} className="text-slate-500" /></button>
                      <AlertCircle size={14} className="text-red-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider text-xs">Blocked</h2>
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.BLOCKED).length || 0}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto pr-2 pb-2 space-y-3 scrollbar-thin scrollbar-thumb-slate-200">
                    {getItemsByStatus(Status.BLOCKED).map((item: AgenFKItem) => (
                      <div 
                        key={item.id} 
                        id={`card-${item.id}`}
                        className={clsx(
                          "bg-white/90 dark:bg-slate-900/90 rounded-xl p-3 shadow-sm border border-red-100 dark:border-red-900/30 cursor-move relative",
                          highlightedId === item.id && "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)] z-10 border-indigo-500"
                        )}
                        draggable 
                        onDragStart={(e) => handleDragStart(e, item.id)}
                        onDoubleClick={() => setSelectedItem(item)}
                      >
                         <div className="flex justify-between items-start mb-2">
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase text-slate-400 border-slate-200 dark:border-slate-700">{item.type}</span>
                            <button onClick={() => updateMutation.mutate({ id: item.id, updates: { status: Status.ARCHIVED } })} className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-300 hover:text-rose-500 transition-colors"><Archive size={12} /></button>
                         </div>
                         <h3 className="font-medium text-slate-700 dark:text-slate-200 text-xs leading-snug">{item.title}</h3>
                      </div>
                    ))}
                    <button onClick={() => setSelectedItem({ type: ItemType.TASK, status: Status.BLOCKED, title: '', description: '', projectId: selectedProjectId! } as any)} className="w-full py-1.5 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-slate-400 dark:text-slate-500 text-xs font-medium hover:border-red-300 dark:hover:border-red-700 hover:text-red-500 dark:hover:text-red-400 transition-all flex items-center justify-center gap-1.5">
                      <Plus size={14} /> Add blocked
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Archived Section */}
            <div className={clsx("flex flex-col transition-all duration-300", isArchiveCollapsed ? (isBlockedCollapsed ? "flex-1" : "h-12 shrink-0") : (isBlockedCollapsed ? "flex-1 h-full" : "flex-1 h-1/2"))}>
              {isArchiveCollapsed ? (
                <button onClick={() => setIsArchiveCollapsed(false)} className="h-full w-full bg-slate-200/50 dark:bg-slate-900/50 rounded-xl flex flex-col items-center justify-center py-4 gap-3 hover:bg-slate-300 dark:hover:bg-slate-800 transition-colors group border border-dashed border-slate-300 dark:border-slate-800">
                  <Archive size={16} className="text-slate-500 group-hover:text-indigo-600 shrink-0" />
                  {isBlockedCollapsed && <span className="[writing-mode:vertical-lr] font-bold text-[10px] uppercase tracking-widest text-slate-500 shrink-0 mt-2">Archived</span>}
                  <span className={clsx("bg-white dark:bg-slate-800 text-slate-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-slate-100 dark:border-slate-700", isBlockedCollapsed && "mt-auto")}>{items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).length || 0}</span>
                </button>
              ) : (
                <div className="flex flex-col h-full bg-slate-100/50 dark:bg-slate-950/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between mb-3 px-1 border-t-4 border-t-slate-300 pt-2">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setIsArchiveCollapsed(true)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-800 rounded"><ChevronLeft size={14} className="text-slate-500" /></button>
                      <Archive size={14} className="text-slate-500" />
                      <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider text-xs">Archived</h2>
                    </div>
                    <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">{items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).length || 0}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto pr-2 pb-2 space-y-3 scrollbar-thin scrollbar-thumb-slate-200">
                    {items?.filter((i: AgenFKItem) => i.status === Status.ARCHIVED).map((item: AgenFKItem) => (
                      <div 
                        key={item.id} 
                        id={`card-${item.id}`}
                        className={clsx(
                          "bg-white/60 dark:bg-slate-900/60 rounded-xl p-3 shadow-sm border border-slate-200 dark:border-slate-800 relative",
                          highlightedId === item.id && "ring-2 ring-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.4)] z-10 border-indigo-500"
                        )}
                        onDoubleClick={() => setSelectedItem(item)}
                      >
                         <div className="flex justify-between items-start mb-2">
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase text-slate-400 border-slate-200 dark:border-slate-700">{item.type}</span>
                            <button onClick={() => updateMutation.mutate({ id: item.id, updates: { status: item.previousStatus || Status.TODO } })} className="p-1 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded text-indigo-500 transition-colors" title="Restore"><ArchiveRestore size={12} /></button>
                         </div>
                         <h3 className="font-medium text-slate-500 dark:text-slate-400 text-xs leading-snug">{item.title}</h3>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {selectedItem && (
        <CardDetailModal 
          item={selectedItem} 
          allItems={items || []}
          pricesData={pricesData}
          onClose={() => setSelectedItem(null)} 
          onSelectItem={setSelectedItem}
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
        />
      )}
    </div>
  );
};
