import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { AgenticItem, ItemType, Status } from '../types';
import { clsx } from 'clsx';
import { 
  Plus, Loader2, AlertCircle, Layout, Tag, 
  AlignLeft, Zap, ChevronRight, Home, ArrowRight,
  Sun, Moon
} from 'lucide-react';
import { io } from 'socket.io-client';
import { CardDetailModal } from './CardDetailModal';
import { useTheme } from '../ThemeContext';

const statuses = Object.values(Status);

interface NavItem {
  id: string;
  title: string;
  type: ItemType;
}

const statusBorderColors: Record<Status, string> = {
  [Status.TODO]: "border-t-slate-400",
  [Status.IN_PROGRESS]: "border-t-blue-500",
  [Status.REVIEW]: "border-t-amber-500",
  [Status.DONE]: "border-t-emerald-500",
  [Status.BLOCKED]: "border-t-red-500",
};

export const KanbanBoard: React.FC = () => {
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();
  const { data: items, isLoading, error } = useQuery({ 
    queryKey: ['items'], 
    queryFn: () => api.listItems() 
  });
  
  const [selectedItem, setSelectedItem] = useState<AgenticItem | null>(null);
  const [navPath, setNavPath] = useState<NavItem[]>([]);
  const [selectedItemType, setSelectedItemType] = useState<ItemType | 'ALL'>('ALL');
  
  // WebSocket setup
  useEffect(() => {
    const socket = io('http://localhost:3000');
    
    socket.on('items_updated', () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient]);

  const updateMutation = useMutation({
    mutationFn: (variables: { id: string, updates: Partial<AgenticItem> }) => 
      api.updateItem(variables.id, variables.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items'] });
    }
  });

  const getItemsByStatus = (status: Status) => {
    if (!items) return [];
    
    let filtered = items.filter((i: AgenticItem) => i.status === status);

    // Navigation Filtering
    if (navPath.length === 0) {
      // Show only Epics and standalone Bugs at root
      filtered = filtered.filter((i: AgenticItem) => i.type === ItemType.EPIC || i.type === ItemType.BUG);
    } else {
      // Show children of the last item in navPath
      const currentParent = navPath[navPath.length - 1];
      filtered = filtered.filter((i: AgenticItem) => i.parentId === currentParent.id);
    }

    // Type Filtering
    if (selectedItemType !== 'ALL') {
      filtered = filtered.filter((i: AgenticItem) => i.type === selectedItemType);
    }

    return filtered;
  };

  const handleDrillDown = (item: AgenticItem) => {
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

  if (isLoading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
        <Loader2 className="h-10 w-10 animate-spin text-blue-500 mb-4" />
        <p className="font-medium">Syncing with Agentic Brain...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 p-8 text-center">
        <AlertCircle className="h-12 w-12 mb-4" />
        <h2 className="text-xl font-bold mb-2 text-red-800 dark:text-red-200">Connection Error</h2>
        <p className="max-w-md">Could not connect to the Agentic Server.</p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-screen bg-slate-100 dark:bg-slate-950 flex flex-col font-sans text-slate-900 dark:text-slate-100 transition-colors duration-300">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex flex-col gap-4 sticky top-0 z-10 shadow-sm dark:shadow-none">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg text-white">
              <Layout size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight transition-colors">Agentic Dashboard</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wider">Project: Agentic Framework</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Theme Toggle */}
            <button 
              onClick={toggleTheme}
              className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors border border-slate-200 dark:border-slate-700 shadow-sm"
              title={theme === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            {/* Item Type Filter */}
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
              <div className="text-xs text-slate-400 dark:text-slate-500 font-medium uppercase tracking-tight">TOTAL TOKENS</div>
              <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400 transition-colors">
                {items?.reduce((acc: number, i: any) => acc + (i.tokenUsage?.reduce((t: number, u: any) => t + u.input + u.output, 0) || 0), 0).toLocaleString()}
              </div>
            </div>
            <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md font-medium text-sm flex items-center gap-2 transition-colors shadow-sm hover:shadow active:scale-95">
              <Plus size={16} />
              <span>New Item</span>
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm overflow-x-auto py-1 border-t border-slate-50 dark:border-slate-800 pt-3">
          <button 
            onClick={() => navigateTo(-1)}
            className={clsx(
              "flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors whitespace-nowrap",
              navPath.length === 0 
                ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-bold" 
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            )}
          >
            <Home size={14} />
            <span>Top Level</span>
          </button>
          {navPath.map((nav, index) => (
            <React.Fragment key={nav.id}>
              <ChevronRight size={14} className="text-slate-300 dark:text-slate-600 flex-shrink-0" />
              <button 
                onClick={() => navigateTo(index)}
                className={clsx(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors whitespace-nowrap",
                  index === navPath.length - 1 
                    ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-bold" 
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                )}
              >
                <span className={clsx(
                  "w-2 h-2 rounded-full",
                  nav.type === ItemType.EPIC ? "bg-purple-400" : "bg-blue-400"
                )}></span>
                <span>{nav.title}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      </header>

      {/* Board */}
      <main className="flex-1 overflow-x-auto p-4 md:p-6">
        <div className="flex flex-col md:flex-row gap-6 h-full">
          {statuses.map(status => (
            <div 
              key={status} 
              className="flex flex-col w-full md:w-80 h-full min-h-[300px] md:min-h-0"
              onDrop={(e) => handleDrop(e, status as Status)}
              onDragOver={handleDragOver}
            >
              <div className={clsx("flex items-center justify-between mb-3 px-1 border-t-4 pt-2", statusBorderColors[status as Status])}>
                <h2 className="font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider">{status.replace('_', ' ')}</h2>
                <span className="bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-xs font-bold px-2 py-1 rounded-full shadow-sm border border-slate-100 dark:border-slate-700">
                  {getItemsByStatus(status as Status).length}
                </span>
              </div>
              
              <div className="flex-1 overflow-y-auto pr-2 pb-10 space-y-3">
                {getItemsByStatus(status as Status).map((item: AgenticItem) => (
                  <div 
                    key={item.id} 
                    className="group bg-white dark:bg-slate-900 rounded-xl p-4 shadow-sm border border-slate-200 dark:border-slate-800 cursor-move hover:shadow-md dark:hover:shadow-indigo-900/10 hover:border-indigo-200 dark:hover:border-indigo-800 transition-all duration-200 relative"
                    draggable
                    onDragStart={(e) => handleDragStart(e, item.id)}
                    onDoubleClick={() => setSelectedItem(item)}
                  >
                    <div className="flex justify-between items-start mb-3">
                      <span className={clsx(
                        "text-[10px] font-bold px-2.5 py-1 rounded-md border uppercase tracking-wider flex items-center gap-1.5",
                        item.type === ItemType.EPIC ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800" :
                        item.type === ItemType.STORY ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800" :
                        item.type === ItemType.TASK ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" :
                        "bg-rose-50 dark:bg-rose-900/20 text-red-700 dark:text-red-300 border-red-100 dark:border-red-800"
                      )}>
                        {item.type}
                      </span>
                      
                      {(item.type === ItemType.EPIC || item.type === ItemType.STORY) && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDrillDown(item); }}
                          className="bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800 text-indigo-600 dark:text-indigo-400 px-2 py-1 rounded text-[10px] font-bold uppercase flex items-center gap-1 transition-colors"
                        >
                          Drill <ArrowRight size={10} />
                        </button>
                      )}
                    </div>
                    
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100 text-sm leading-snug mb-2 group-hover:text-indigo-700 dark:group-hover:text-indigo-400 transition-colors">
                      {item.title}
                    </h3>
                    
                    {item.description && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-3">
                        {item.description}
                      </p>
                    )}
                    
                    <div className="flex items-center justify-between pt-3 border-t border-slate-50 dark:border-slate-800 mt-auto text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                      <span>#{item.id.substring(0, 4)}</span>
                      {item.tokenUsage && item.tokenUsage.length > 0 && (
                        <div className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded-full">
                          <Zap size={10} className="fill-amber-600 dark:fill-amber-400" />
                          {item.tokenUsage.reduce((acc, curr) => acc + curr.input + curr.output, 0).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                
                <button className="w-full py-2 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-slate-400 dark:text-slate-500 text-sm font-medium hover:border-indigo-300 dark:hover:border-indigo-700 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-all flex items-center justify-center gap-2">
                  <Plus size={16} /> Add {status.toLowerCase()}
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>

      {selectedItem && <CardDetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </div>
  );
};
