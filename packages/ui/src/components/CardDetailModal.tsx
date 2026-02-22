import React from 'react';
import { AgenFKItem, ItemType, Status } from '../types';
import { 
  X, Layout, Tag, AlignLeft, AlertCircle, Zap, 
  Clock, Calendar, FileText, ArrowLeft, Plus, 
  Loader2, ShieldCheck, FlaskConical 
} from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface CardDetailModalProps {
  item: AgenFKItem;
  allItems: AgenFKItem[];
  onClose: () => void;
  onSelectItem: (item: AgenFKItem) => void;
  onAddItem: (title: string, type: ItemType) => Promise<void>;
}

type TabType = 'overview' | 'plan' | 'subitems' | 'history' | 'tests' | 'reviews' | 'usage';

export const CardDetailModal: React.FC<CardDetailModalProps> = ({ item, allItems, onClose, onSelectItem, onAddItem }) => {
  const [activeTab, setActiveTab] = React.useState<TabType>('overview');
  const [newSubitemTitle, setNewSubitemTitle] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const totalTokens = item.tokenUsage?.reduce((acc, curr) => acc + curr.input + curr.output, 0) || 0;
  const subitems = allItems.filter(i => i.parentId === item.id);
  const parentItem = item.parentId ? allItems.find(i => i.id === item.parentId) : null;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: <AlignLeft size={14} /> },
    { id: 'plan', label: 'Plan', icon: <FileText size={14} />, hidden: !item.implementationPlan },
    { id: 'subitems', label: 'Subitems', icon: <Layout size={14} />, badge: subitems.length, hidden: item.type === ItemType.TASK || item.type === ItemType.BUG },
    { id: 'history', label: 'History', icon: <Clock size={14} />, badge: item.history?.length },
    { id: 'tests', label: 'Test Results', icon: <FlaskConical size={14} />, badge: item.reviews?.length },
    { id: 'reviews', label: 'Reviews', icon: <ShieldCheck size={14} />, hidden: true },
    { id: 'usage', label: 'Usage', icon: <Zap size={14} />, hidden: !item.tokenUsage?.length },
  ].filter(t => !t.hidden);

  // Auto-switch tab if current is hidden (e.g. after item change)
  React.useEffect(() => {
    if (tabs.length > 0 && !tabs.find(t => t.id === activeTab)) {
      setActiveTab(tabs[0].id as TabType);
    }
  }, [item.id, tabs, activeTab]);

  // Scroll to top on item change
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo(0, 0);
    }
  }, [item.id]);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubitemTitle.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // Determine default subitem type
      const type = item.type === ItemType.EPIC ? ItemType.STORY : ItemType.TASK;
      await onAddItem(newSubitemTitle, type);
      setNewSubitemTitle('');
    } catch (err) {
      console.error("Failed to add subitem:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!item) return null;


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-black/70 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200 border border-slate-200 dark:border-slate-800">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
          <div className="flex items-center gap-3">
            {parentItem && (
              <button 
                onClick={() => { onSelectItem(parentItem); setActiveTab('subitems'); }}
                className="mr-2 p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md text-indigo-600 dark:text-indigo-400 transition-colors flex items-center gap-1 text-xs font-bold uppercase"
                title={`Back to ${parentItem.title}`}
              >
                <ArrowLeft size={14} />
                <span className="hidden sm:inline">Back</span>
              </button>
            )}
            <span className={clsx(
              "text-xs font-bold px-2.5 py-1 rounded-md border uppercase tracking-wider flex items-center gap-1.5",
              item.type === ItemType.EPIC ? "bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800" :
              item.type === ItemType.STORY ? "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800" :
              item.type === ItemType.TASK ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" :
              "bg-rose-50 dark:bg-rose-900/20 text-red-700 dark:text-red-300 border-red-100 dark:border-red-800"
            )}>
              {item.type === ItemType.EPIC && <Layout size={12} />}
              {item.type === ItemType.STORY && <Tag size={12} />}
              {item.type === ItemType.TASK && <AlignLeft size={12} />}
              {item.type === ItemType.BUG && <AlertCircle size={12} />}
              {item.type}
            </span>
            <span className="text-sm font-mono text-slate-400 dark:text-slate-500">ID: {item.id.substring(0, 8)}</span>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex px-6 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as TabType)}
              className={clsx(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap outline-none",
                activeTab === tab.id 
                  ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" 
                  : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              )}
            >
              {tab.icon}
              {tab.label}
              {tab.badge !== undefined && (
                <span className={clsx(
                  "ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                  activeTab === tab.id ? "bg-indigo-100 text-indigo-600" : "bg-slate-100 text-slate-500"
                )}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Modal Body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-8">
          {activeTab === 'overview' && (
            <>
              <div>
                <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100 leading-tight mb-2">
                  {item.title}
                </h2>
                <div className="flex flex-wrap gap-4 text-sm text-slate-500 dark:text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <Clock size={14} />
                    <span>Status: <span className="font-semibold text-indigo-600 dark:text-indigo-400">{item.status}</span></span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Calendar size={14} />
                    <span>Created: {new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Description</h4>
                <div className="bg-slate-50 dark:bg-slate-950 rounded-xl p-4 text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap min-h-[100px] border border-slate-100 dark:border-slate-800 text-sm">
                  {item.description || <span className="italic text-slate-400 dark:text-slate-600">No description provided.</span>}
                </div>
              </div>

              {subitems.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Progress</h4>
                    <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                      {Math.round((subitems.filter(i => i.status === Status.DONE).length / subitems.length) * 100)}%
                    </span>
                  </div>
                  <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-indigo-500 rounded-full transition-all duration-500" 
                      style={{ width: `${(subitems.filter(i => i.status === Status.DONE).length / subitems.length) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Metrics</h4>
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className="bg-amber-100 dark:bg-amber-900/30 p-2 rounded-lg text-amber-600 dark:text-amber-400">
                        <Zap size={18} />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-tight">Total Tokens</div>
                        <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{totalTokens.toLocaleString()}</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Hierarchy</h4>
                  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className="bg-slate-100 dark:bg-slate-800 p-2 rounded-lg text-slate-600 dark:text-slate-400 font-mono text-xs">
                        #
                      </div>
                      <div>
                        <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-tight">Parent</div>
                        <div 
                          className={clsx(
                            "text-xs font-mono truncate max-w-[150px] cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors",
                            parentItem ? "text-indigo-500 font-bold" : "text-slate-400"
                          )} 
                          title={item.parentId}
                          onClick={() => parentItem && onSelectItem(parentItem)}
                        >
                          {parentItem ? parentItem.title : (item.parentId || "None")}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'plan' && item.implementationPlan && (
            <div className="animate-in slide-in-from-bottom-2 duration-300">
              <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                <FileText size={14} />
                Implementation Plan
              </h4>
              <div className="prose prose-slate dark:prose-invert prose-sm max-w-none bg-slate-50 dark:bg-slate-950 rounded-xl p-6 border border-slate-100 dark:border-slate-800">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {item.implementationPlan}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {activeTab === 'subitems' && (
            <div className="animate-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                  Child Items ({subitems.length})
                </h4>
                
                <form onSubmit={handleQuickAdd} className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder={`Quick add ${item.type === ItemType.EPIC ? 'Story' : 'Task'}...`}
                    value={newSubitemTitle}
                    onChange={(e) => setNewSubitemTitle(e.target.value)}
                    className="text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-500 min-w-[200px]"
                    disabled={isSubmitting}
                  />
                  <button 
                    type="submit"
                    disabled={!newSubitemTitle.trim() || isSubmitting}
                    className="p-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:bg-slate-400 text-white rounded transition-colors"
                  >
                    {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  </button>
                </form>
              </div>

              {subitems.length > 0 ? (
                <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                      <tr>
                        <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase">Type</th>
                        <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase">Title</th>
                        <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {subitems.map((sub) => (
                        <tr 
                          key={sub.id} 
                          className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer"
                          onClick={() => { onSelectItem(sub); setActiveTab('overview'); }}
                        >
                          <td className="px-4 py-3">
                            <span className={clsx(
                              "text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase",
                              sub.type === ItemType.EPIC ? "bg-purple-50 text-purple-700 border-purple-100 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800" :
                              sub.type === ItemType.STORY ? "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800" :
                              sub.type === ItemType.TASK ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800" :
                              "bg-rose-50 dark:bg-rose-900/20 text-red-700 border-red-100 dark:bg-rose-900/20 dark:text-red-300 border-red-800"
                            )}>
                              {sub.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">{sub.title}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={clsx(
                              "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase",
                              sub.status === Status.DONE ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                              sub.status === Status.IN_PROGRESS ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
                              "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                            )}>
                              {sub.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 bg-slate-50 dark:bg-slate-950 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-slate-400 text-sm italic">No subitems found.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'tests' && (
            <div className="animate-in slide-in-from-bottom-2 duration-300 space-y-6">
              <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                Verification & Test History ({item.reviews?.length || 0})
              </h4>
              
              {item.reviews && item.reviews.length > 0 ? (
                <div className="space-y-4">
                  {[...item.reviews].sort((a, b) => new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime()).map((review) => (
                    <div key={review.id} className="bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-100 dark:border-slate-800 overflow-hidden">
                      <div className={clsx(
                        "px-4 py-2 border-b flex items-center justify-between",
                        review.status === 'PASSED' 
                          ? "bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/30" 
                          : "bg-rose-50/50 dark:bg-rose-900/10 border-rose-100 dark:border-rose-900/30"
                      )}>
                        <div className="flex items-center gap-2">
                          <span className={clsx(
                            "text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase",
                            review.status === 'PASSED' 
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" 
                              : "bg-rose-100 text-red-700 dark:bg-rose-900/30 dark:text-red-400"
                          )}>
                            {review.status}
                          </span>
                          <code className="text-xs font-mono text-slate-600 dark:text-slate-400">{review.command}</code>
                        </div>
                        <span className="text-[10px] text-slate-400 dark:text-slate-500">
                          {new Date(review.executedAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="p-4 overflow-x-auto bg-slate-900/5 dark:bg-black/20">
                        <pre className="text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre leading-relaxed">
                          {review.output}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-slate-50 dark:bg-slate-950 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-slate-400 text-sm italic">No test results found. Move item to REVIEW to trigger verification.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="animate-in slide-in-from-bottom-2 duration-300 space-y-4">
              <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                State Transitions ({item.history?.length || 0})
              </h4>
              
              {item.history && item.history.length > 0 ? (
                <div className="relative space-y-4 before:absolute before:left-3.5 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-slate-100 dark:before:bg-slate-800">
                  {[...item.history].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((record) => (
                    <div key={record.id} className="relative pl-10">
                      <div className="absolute left-1.5 top-1.5 w-4 h-4 rounded-full bg-white dark:bg-slate-900 border-2 border-indigo-500 z-10" />
                      <div className="bg-slate-50 dark:bg-slate-950/50 rounded-xl p-3 border border-slate-100 dark:border-slate-800/50">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 uppercase">
                              {record.fromStatus}
                            </span>
                            <span className="text-slate-400">→</span>
                            <span className={clsx(
                              "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                              record.toStatus === Status.DONE ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                              record.toStatus === Status.IN_PROGRESS ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
                              "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400"
                            )}>
                              {record.toStatus}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-400 dark:text-slate-500">
                            {new Date(record.timestamp).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-slate-50 dark:bg-slate-950 rounded-xl border border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-slate-400 text-sm italic">No state transitions recorded.</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'usage' && item.tokenUsage && (
            <div className="animate-in slide-in-from-bottom-2 duration-300">
              <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Usage History</h4>
              <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                    <tr>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase">Model</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase">Input</th>
                      <th className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 text-[10px] uppercase">Output</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {item.tokenUsage.map((u, i) => (
                      <tr key={i} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-indigo-600 dark:text-indigo-400">{u.model}</td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{u.input.toLocaleString()}</td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400">{u.output.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end bg-slate-50/50 dark:bg-slate-800/50">
          <button 
            onClick={onClose}
            className="bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-lg font-medium text-sm transition-all shadow-sm active:scale-95"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
