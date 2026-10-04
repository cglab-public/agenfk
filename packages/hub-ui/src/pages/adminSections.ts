// The admin area's sections, grouped by what they are about rather than listed
// flat: people and machines, who may get in, what runs across the fleet, and
// the hub's own settings. `to` is the route under /admin (App.tsx); the labels
// are what an admin reads, so they say what the section does.
import type { LucideIcon } from 'lucide-react';
import { ShieldCheck, KeyRound, Users, GitBranch, ArrowUpCircle, Server, ArrowRightLeft, UserCheck, Tags, Ticket, Building2, ScrollText } from 'lucide-react';

export interface AdminSection { to: string; label: string; icon: LucideIcon }
export interface AdminGroup { id: string; label: string; sections: AdminSection[] }

export const ADMIN_GROUPS: AdminGroup[] = [
  {
    id: 'people', label: 'People', sections: [
      { to: 'users', label: 'Users', icon: Users },
      { to: 'identities', label: 'Identities', icon: UserCheck },
      { to: 'installations', label: 'Installations', icon: Server },
    ],
  },
  {
    id: 'access', label: 'Access', sections: [
      { to: 'auth', label: 'Sign-in', icon: ShieldCheck },
      { to: 'keys', label: 'API keys & invites', icon: KeyRound },
    ],
  },
  {
    id: 'fleet', label: 'Fleet', sections: [
      { to: 'upgrades', label: 'Upgrades', icon: ArrowUpCircle },
      { to: 'flows', label: 'Flows', icon: GitBranch },
      { to: 'models', label: 'Models', icon: Tags },
    ],
  },
  {
    id: 'hub', label: 'Hub', sections: [
      { to: 'org', label: 'Organization', icon: Building2 },
      { to: 'repoint', label: 'Address change', icon: ArrowRightLeft },
      { to: 'jira', label: 'JIRA integration', icon: Ticket },
      { to: 'audit', label: 'Audit log', icon: ScrollText },
    ],
  },
];
