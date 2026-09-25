/**
 * CGLAB-384 — a column's contract at a glance: how many checks the server runs
 * when a card leaves it, and whether a person must approve first (and sign
 * with a passkey). They share the header's second line with the step's role
 * (ColumnRole, b13f37e6; 85b59d8c).
 */
import React from 'react';
import { CheckCheck, KeyRound, UserCheck } from 'lucide-react';
import { ROLE_TEXTS } from '@agenfk/flow-editor';
import type { FlowStep } from '../types';

/** The step's role in the flow editor's words, under the step name; what it means is the tooltip. */
export const ColumnRole: React.FC<{ step: FlowStep }> = ({ step }) => {
  if (typeof step.role !== 'string') return null;
  const text = ROLE_TEXTS[step.role];
  return (
    <span data-testid={`column-role-${step.name}`} title={text?.desc} className="min-w-0 truncate text-[10px] font-semibold text-slate-500 dark:text-slate-400 normal-case tracking-normal leading-tight">
      {text?.name ?? step.role}
    </span>
  );
};

/**
 * The checks as an icon and a number; which checks they are is the tooltip
 * (85b59d8c). Renders nothing for a step with neither checks nor approval, so
 * the header's second line stays the same height either way.
 */
export const ColumnContractBadges: React.FC<{ step: FlowStep; checkCount?: number; checkNames?: string[] }> = ({ step, checkCount, checkNames }) => {
  const approval = (Array.isArray(step.checks) ? step.checks : []).find(c => c.id === 'human-approval');
  if (!approval && !checkCount) return null;
  const counted = checkCount ? `${checkCount} ${checkCount === 1 ? 'check' : 'checks'}` : '';
  return (
    <span data-testid={`column-contract-${step.name}`} className="flex items-center gap-1 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
      {!!checkCount && (
        <span
          data-testid={`column-checks-${step.name}`}
          aria-label={counted}
          title={checkNames?.length ? `${counted}: ${checkNames.join(', ')}` : counted}
          className="flex items-center gap-0.5 tabular-nums"
        >
          <CheckCheck size={11} aria-hidden="true" />{checkCount}
        </span>
      )}
      {approval && <UserCheck size={12} aria-label="A person must approve" className="text-amber-600" />}
      {approval?.params?.signature === 'passkey' && <KeyRound size={12} aria-label="Signed with a passkey" className="text-amber-600" />}
    </span>
  );
};
