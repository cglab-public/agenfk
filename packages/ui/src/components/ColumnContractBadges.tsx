/**
 * CGLAB-384 — a column's contract at a glance: the step's role, how many
 * checks the server runs when a card leaves it, and whether a person must
 * approve first (and sign with a passkey).
 */
import React from 'react';
import { KeyRound, UserCheck } from 'lucide-react';
import { ROLE_TEXTS } from '@agenfk/flow-editor';
import type { FlowStep } from '../types';

export const ColumnContractBadges: React.FC<{ step: FlowStep; checkCount?: number }> = ({ step, checkCount }) => {
  const role = typeof step.role === 'string' ? (ROLE_TEXTS[step.role]?.name ?? step.role) : null;
  const approval = (Array.isArray(step.checks) ? step.checks : []).find(c => c.id === 'human-approval');
  if (!role && !approval && !checkCount) return null;
  return (
    <span data-testid={`column-contract-${step.name}`} className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
      {role && <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 normal-case tracking-normal">{role}</span>}
      {!!checkCount && <span className="normal-case tracking-normal">{checkCount} {checkCount === 1 ? 'check' : 'checks'}</span>}
      {approval && <UserCheck size={12} aria-label="A person must approve" className="text-amber-600" />}
      {approval?.params?.signature === 'passkey' && <KeyRound size={12} aria-label="Signed with a passkey" className="text-amber-600" />}
    </span>
  );
};
