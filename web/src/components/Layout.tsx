import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes, Clapperboard, Coins, FolderKanban, Images, LayoutDashboard, ListChecks, Mic2, PlugZap, Plus, Settings, SquareStack,
} from 'lucide-react';
import { NavLink, Outlet, useRouteError, isRouteErrorResponse, Link } from 'react-router';
import { api } from '../lib/api';
import type { Job } from '../lib/types';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/create', label: 'Create', icon: Plus },
  { to: '/templates', label: 'Templates', icon: SquareStack },
  { to: '/assets', label: 'Assets', icon: Images },
  { to: '/voices', label: 'Voices', icon: Mic2 },
  { to: '/providers', label: 'Providers', icon: PlugZap },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/costs', label: 'Costs', icon: Coins },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const active = useQuery({ queryKey: ['jobs', 'active'], queryFn: () => api.get<Job[]>('/jobs?status=active'), refetchInterval: 2500 });
  const n = active.data?.length ?? 0;
  return (
    <div className="flex h-full">
      <aside className="flex w-[212px] shrink-0 flex-col border-r border-line bg-panel">
        <Link to="/" className="flex items-center gap-2.5 px-4 pt-4 pb-5">
          <div className="grid size-7 place-items-center rounded-lg bg-accent text-[#0b0d1a]"><Clapperboard className="size-4" /></div>
          <div>
            <div className="text-[13px] font-semibold leading-tight">AF6 Studio</div>
            <div className="text-[10px] text-faint">Narration-first production</div>
          </div>
        </Link>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] transition-colors',
                isActive ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg')}>
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {label === 'Jobs' && n > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent-strong tabular-nums">{n}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="m-3 rounded-lg border border-line bg-bg/60 p-3 text-[11px] text-muted">
          <div className="flex items-center gap-1.5 font-medium text-fg"><Boxes className="size-3.5" /> Mock providers</div>
          <div className="mt-1 leading-relaxed">Generation is simulated. No credits are used.</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : 'Unknown error';
  return (
    <div className="grid h-full place-items-center p-10">
      <div className="max-w-md text-center">
        <div className="text-[16px] font-semibold">Something went wrong</div>
        <p className="mt-2 break-words text-muted">{msg}</p>
        <Link to="/"><Button className="mt-4">Back to dashboard</Button></Link>
      </div>
    </div>
  );
}
