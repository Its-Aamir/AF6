import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { JobStatusBadge } from '../components/common';
import { Button, Empty, PageHeader, Progress, Segmented, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { ago, JOB_LABEL } from '../lib/format';
import { useAction } from '../lib/hooks';
import type { Job } from '../lib/types';

export function JobList({ jobs, compact }: { jobs: Job[]; compact?: boolean }) {
  const retry = useAction((id: string) => api.post(`/jobs/${id}/retry`), { success: 'Retry queued', invalidate: [['jobs'], ['project']] });
  const cancel = useAction((id: string) => api.post(`/jobs/${id}/cancel`), { success: 'Cancellation requested', invalidate: [['jobs'], ['project']] });
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-panel text-[11px] tracking-wide text-muted uppercase">
          <tr>{['Job', !compact && 'Project', 'Status', 'Progress', 'Attempts', 'Updated', ''].filter((h) => h !== false).map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t border-line align-top">
              <td className="px-3 py-2.5"><div className="font-medium">{JOB_LABEL[j.type] ?? j.type}</div><div className="font-mono text-[10px] text-faint">{j.id.slice(0, 8)}</div></td>
              {!compact && <td className="px-3 py-2.5">{j.projectId ? <Link className="hover:text-accent" to={`/projects/${j.projectId}/storyboard`}>{j.projectTitle}</Link> : <span className="text-faint">library</span>}</td>}
              <td className="px-3 py-2.5"><JobStatusBadge status={j.status} /></td>
              <td className="w-[34%] px-3 py-2.5">
                {(j.status === 'running' || j.status === 'queued') && <Progress value={j.progress} className="mb-1" />}
                <div className="text-muted">
                  {j.status === 'failed' || j.status === 'cancelled' ? <span className="text-bad">{j.error}</span>
                    : j.status === 'succeeded' ? `Completed${j.startedAt && j.finishedAt ? ` in ${((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000).toFixed(1)}s` : ''}`
                      : j.progressMessage ?? (j.status === 'queued' ? `Scheduled ${ago(j.runAt)}` : '')}
                </div>
                {(j.status === 'running' || j.status === 'queued') && j.error && <div className="mt-0.5 text-[11px] text-warn">Retrying after: {j.error}</div>}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-muted">{j.attempts}/{j.maxAttempts}</td>
              <td className="px-3 py-2.5 text-muted">{ago(j.updatedAt)}</td>
              <td className="px-3 py-2.5 text-right">
                {(j.status === 'failed' || j.status === 'cancelled') && <Button size="xs" icon={<RotateCcw className="size-3" />} onClick={() => retry.mutate(j.id)}>Retry</Button>}
                {(j.status === 'running' || j.status === 'queued') && <Button size="xs" variant="ghost" icon={<Square className="size-3" />} disabled={j.cancelRequested} onClick={() => cancel.mutate(j.id)}>{j.cancelRequested ? 'Cancelling' : 'Cancel'}</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobsPage() {
  const [status, setStatus] = useState<'active' | 'failed' | 'all'>('all');
  const q = useQuery({ queryKey: ['jobs', status], queryFn: () => api.get<Job[]>(`/jobs${status === 'all' ? '' : `?status=${status}`}`), refetchInterval: 2000 });
  return (
    <div className="mx-auto max-w-[1300px] p-8">
      <PageHeader title="Jobs" subtitle="Durable background work. Jobs survive browser refreshes and worker restarts; failures are retried with backoff."
        actions={<Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'failed', label: 'Failed' }]} />} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty title="No jobs">Jobs appear when you generate scripts, narration, visuals or renders.</Empty> : <JobList jobs={q.data} />}
    </div>
  );
}
