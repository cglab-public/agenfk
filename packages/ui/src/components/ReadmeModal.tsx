import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Book, X, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { useTheme } from '../ThemeContext';

interface ReadmeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const Mermaid: React.FC<{ chart: string }> = ({ chart }) => {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (ref.current && chart) {
      const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
      });
      mermaid.render(id, chart).then(({ svg }) => {
        if (ref.current) {
          ref.current.innerHTML = svg;
        }
      }).catch((err) => {
        console.error("Mermaid render error:", err);
      });
    }
  }, [chart, theme]);

  return <div ref={ref} className="flex justify-center my-4 overflow-x-auto" />;
};

export const ReadmeModal: React.FC<ReadmeModalProps> = ({ isOpen, onClose }) => {
  const { data: readme, isLoading } = useQuery({
    queryKey: ['projectReadme'],
    queryFn: api.getReadme,
    enabled: isOpen,
    staleTime: 60 * 1000,
  });

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
    }
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-4xl mx-4 h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg">
              <Book size={20} className="text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="font-bold text-slate-800 dark:text-slate-100 text-lg">Project README</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Documentation for the installed framework</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 md:px-10 py-8 scrollbar-thin scrollbar-thumb-slate-200 dark:scrollbar-thumb-slate-800">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
              <Loader2 size={24} className="animate-spin" />
              <span className="text-sm font-medium">Loading documentation...</span>
            </div>
          ) : readme ? (
            <div className="prose prose-sm md:prose-base dark:prose-invert max-w-none prose-pre:bg-slate-50 dark:prose-pre:bg-slate-950 prose-pre:border dark:prose-pre:border-slate-800 prose-img:rounded-xl">
              <ReactMarkdown 
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ node, inline, className, children, ...props }: any) {
                    const match = /language-mermaid/.exec(className || '');
                    return !inline && match ? (
                      <Mermaid chart={String(children).replace(/\n$/, '')} />
                    ) : (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  }
                }}
              >
                {readme.content}
              </ReactMarkdown>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 text-sm">
              Unable to load README.md
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg font-bold text-sm transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
