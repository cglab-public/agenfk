import React from 'react';
import { AgenticItem, ItemType, Status } from '../types';
import { X, Layout, Tag, AlignLeft, AlertCircle, Zap, Clock, Calendar, FileText } from 'lucide-react';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface CardDetailModalProps {
  item: AgenticItem;
  onClose: () => void;
}

export const CardDetailModal: React.FC<CardDetailModalProps> = ({ item, onClose }) => {
  const totalTokens = item.tokenUsage?.reduce((acc, curr) => acc + curr.input + curr.output, 0) || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 dark:bg-black/70 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200 border border-slate-200 dark:border-slate-800">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
          <div className="flex items-center gap-3">
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
            <span className="text-sm font-mono text-slate-400 dark:text-slate-500">ID: {item.id}</span>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-8 space-y-8">
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
            <div className="bg-slate-50 dark:bg-slate-950 rounded-xl p-4 text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap min-h-[100px] border border-slate-100 dark:border-slate-800">
              {item.description || <span className="italic text-slate-400 dark:text-slate-600">No description provided.</span>}
            </div>
          </div>

          {item.implementationPlan && (
            <div>
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-3">Metrics</h4>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="bg-amber-100 dark:bg-amber-900/30 p-2 rounded-lg text-amber-600 dark:text-amber-400">
                    <Zap size={18} />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase">Accumulated Tokens</div>
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
                    <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase">Parent ID</div>
                    <div className="text-sm font-mono text-slate-900 dark:text-slate-100">{item.parentId || "None"}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {item.tokenUsage && item.tokenUsage.length > 0 && (
            <div>
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
