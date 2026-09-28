import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Clapperboard, Coins, Film, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { AssetThumb, JobStatusBadge, ProjectStatusBadge } from '../components/common';
import { Button, Empty, PageHeader, Panel, Progress, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { ago, JOB_LABEL, secs, usd } from '../lib/format';
import type { Job, ProjectSummary } from '../lib/types';

interface DashboardData {
  stats: { projects: number; rendered: number; spendThisMonthUsd: number; activeJobs: number; failedJobs24h: number };
  recentProjects: ProjectSummary[];
  activeJobs: Job[];
}

export function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard'), refetchInterval: 3000 });
  const d = q.data;
  return (
    <div className="mx-auto max-w-[1280px] p-8">
      <PageHeader title="Dashboard" subtitle="Your production floor at a glance."
        actions={<Link to="/create"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>} />
      {q.isLoading && <Spinner />}
      {q.error && <div className="text-bad">{(q.error as Error).message}</div>}
      {d && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <Stat label="Projects" value={d.stats.projects} icon={<Clapperboard className="size-3.5" />} sub={`${d.stats.rendered} rendered`} />
            <Stat label="Active jobs" value={d.stats.activeJobs} icon={<Activity className="size-3.5" />} sub="running or queued" />
            <Stat label="Failed jobs (24h)" value={d.stats.failedJobs24h} icon={<AlertTriangle className="size-3.5" />} sub={d.stats.failedJobs24h ? <Link className="text-accent" to="/jobs">Review in Jobs</Link> : 'all clear'} />
            <Stat label="Spend this month" value={usd(d.stats.spendThisMonthUsd, 2)} icon={<Coins className="size-3.5" />} sub="simulated (mock providers)" />
          </div>
          <div className="mt-6 grid grid-cols-[1fr_380px] gap-6">
            <Panel title="Recent projects" actions={<Link to="/projects" className="text-[12px] text-muted hover:text-fg">All projects →</Link>} bodyClassName="p-3">
              {d.recentProjects.length === 0 ? (
                <Empty icon={<Film className="size-6" />} title="No projects yet" action={<Link to="/create"><Button variant="primary">Create your first video</Button></Link>}>
                  Start from a topic or paste a script. Pick a Channel Recipe and the studio takes it from narration to render.
                </Empty>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {d.recentProjects.map((p) => (
                    <Link key={p.id} to={`/projects/${p.id}/storyboard`} className="group overflow-hidden rounded-lg border border-line bg-panel-2 transition-colors hover:border-line-strong">
                      <AssetThumb asset={p.thumbnail ? { id: p.thumbnail.assetId, mediaType: p.thumbnail.mediaType as 'image' } : null} className="aspect-video" />
                      <div className="p-3">
                        <div className="truncate font-medium group-hover:text-accent-strong">{p.title}</div>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <ProjectStatusBadge status={p.status} />
                          <span className="text-[11px] text-faint">{ago(p.updatedAt)}</span>
                        </div>
                        <div className="mt-2 flex justify-between text-[11px] text-muted">
                          <span>{p.scenesReady}/{p.scenes} scenes</span><span>{secs(p.narrationDurationSec)}</span><span>{usd(p.spentUsd, 2)}</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="Active jobs" actions={<Link to="/jobs" className="text-[12px] text-muted hover:text-fg">Jobs →</Link>}>
              {d.activeJobs.length === 0 ? <div className="py-6 text-center text-muted">Nothing running.</div> : (
                <ul className="space-y-3">
                  {d.activeJobs.map((j) => (
                    <li key={j.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate"><span className="font-medium">{JOB_LABEL[j.type] ?? j.type}</span> <span className="text-muted">· {j.projectTitle ?? 'library'}</span></span>
                        <JobStatusBadge status={j.status} />
                      </div>
                      <Progress className="mt-1.5" value={j.progress} />
                      <div className="mt-1 truncate text-[11px] text-faint">{j.progressMessage ?? 'Waiting for a worker…'}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
