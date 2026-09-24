/**
 * CGLAB-384 — a column's contract at a glance: how many checks the server runs
 * when a card leaves it, and whether a person must approve first (and sign
 * with a passkey). The step's role has its own line under the step name
 * (ColumnRole, b13f37e6).
 */
import React from 'react';
import { KeyRound, UserCheck } from 'lucide-react';
import { ROLE_TEXTS } from '@agenfk/flow-editor';
import type { FlowStep } from '../types';

/** The step's role in the flow editor's words, under the step name; what it means is the tooltip. */
export const ColumnRole: React.FC<{ step: FlowStep }> = ({ step }) => {
  if (typeof step.role !== 'string') return null;
  const text = ROLE_TEXTS[step.role];
  return (
    <span data-testid={`column-role-${step.name}`} title={text?.desc} className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 normal-case tracking-normal leading-tight">
      {text?.name ?? step.role}
    </span>
  );
};

export const ColumnContractBadges: React.FC<{ step: FlowStep; checkCount?: number }> = ({ step, checkCount }) => {
  const approval = (Array.isArray(step.checks) ? step.checks : []).find(c => c.id === 'human-approval');
  if (!approval && !checkCount) return null;
  return (
    <span data-testid={`column-contract-${step.name}`} className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
      {!!checkCount && <span className="normal-case tracking-normal">{checkCount} {checkCount === 1 ? 'check' : 'checks'}</span>}
      {approval && <UserCheck size={12} aria-label="A person must approve" className="text-amber-600" />}
      {approval?.params?.signature === 'passkey' && <KeyRound size={12} aria-label="Signed with a passkey" className="text-amber-600" />}
    </span>
  );
};
