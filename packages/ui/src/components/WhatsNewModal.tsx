import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Sparkles, X, ExternalLink, Loader2, ArrowUpCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  currentVersion: string;
}

const isNewerVersion = (latest: string, current: string): boolean => {
  if (!latest || !current) return false;
  const clean = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const l = clean(latest);
  const c = clean(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
};

interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const { data: release, isLoading } = useQuery<ReleaseInfo>({
    queryKey: ['latestRelease'],
    queryFn: api.getLatestRelease,
    staleTime: 15 * 60 * 1000,
    retry: false,
    enabled: isOpen,
  });

  if (!isOpen) return null;

  const hasUpdate = release ? isNewerVersion(release.version, release.currentVersion) : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg">
              <Sparkles size={20} className="text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h2 className="font-bold text-slate-800 dark:text-slate-100 text-lg">What's New</h2>
              {release && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                    v{release.currentVersion}
                  </span>
                </p>
              )}
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
        <div className="flex-1 flex flex-col overflow-hidden">
          {isLoading ? (
            <div className="flex flex-col gap-3 p-6">
              <div className="flex items-center gap-2 text-slate-400">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-sm">Loading release notes...</span>
              </div>
              <div className="space-y-2">
                <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse w-3/4" />
                <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse w-full" />
                <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse w-5/6" />
                <div className="h-4 bg-slate-100 dark:bg-slate-800 rounded animate-pulse w-2/3" />
              </div>
            </div>
          ) : release ? (
            <>
              {release.name && (
                <div className="px-6 pt-4 shrink-0">
                  <h3 className="font-semibold text-slate-700 dark:text-slate-200">{release.name}</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Released{' '}
                    {new Date(release.publishedAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </div>
              )}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-slate-800 dark:prose-headings:text-slate-200">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {(release.body || 'No release notes available.').replace(/\\n/g, '\n')}
                  </ReactMarkdown>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center p-8 text-slate-400 text-sm">
              Unable to load release notes.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
          {hasUpdate && release ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
              <ArrowUpCircle size={14} />
              <span>v{release.version} available — see the update notification</span>
            </div>
          ) : (
            <span className="text-xs text-slate-400">You're up to date</span>
          )}
          {release && (
            <a
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-medium transition-colors"
            >
              <ExternalLink size={14} />
              View on GitHub
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
