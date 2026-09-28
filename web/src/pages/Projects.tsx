import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AssetThumb, ProjectStatusBadge } from '../components/common';
import { useToast } from '../components/toast';
import { Button, Empty, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { ago, secs, usd } from '../lib/format';
import { useAction } from '../lib/hooks';
import type { ProjectSummary } from '../lib/types';

export function ProjectsPage() {
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectSummary[]>('/projects'), refetchInterval: 4000 });
  const [filter, setFilter] = useState('');
  const nav = useNavigate();
  const { confirm } = useToast();
  const del = useAction((id: string) => api.del(`/projects/${id}`), { success: 'Project deleted', invalidate: [['projects']] });
  const rows = (q.data ?? []).filter((p) => p.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="mx-auto max-w-[1280px] p-8">
      <PageHeader title="Projects" subtitle="Every project is saved continuously — close the tab anytime."
        actions={<>
          <div className="relative"><Search className="absolute top-2 left-2.5 size-4 text-faint" /><input className="input w-64 pl-8" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <Link to="/create"><Button variant="primary" icon={<Plus className="size-4" />}>New project</Button></Link>
        </>} />
      {q.isLoading ? <Spinner /> : rows.length === 0 ? (
        <Empty title={filter ? 'No matching projects' : 'No projects yet'} action={!filter && <Link to="/create"><Button variant="primary">Create a project</Button></Link>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-left">
            <thead className="bg-panel text-[11px] tracking-wide text-muted uppercase">
              <tr>{['', 'Title', 'Recipe', 'Status', 'Scenes', 'Length', 'Spend / budget', 'Updated', ''].map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer border-t border-line hover:bg-panel/70" onClick={() => nav(`/projects/${p.id}/storyboard`)}>
                  <td className="w-24 py-2 pl-3"><AssetThumb asset={p.thumbnail ? { id: p.thumbnail.assetId, mediaType: p.thumbnail.mediaType as 'image' } : null} className="aspect-video w-20 rounded" playOnHover={false} /></td>
                  <td className="px-3 font-medium">{p.title}{p.lastError && <div className="max-w-sm truncate text-[11px] font-normal text-bad">{p.lastError}</div>}</td>
                  <td className="px-3 text-muted">{p.recipeName} <span className="text-faint">· {p.aspectRatio}</span></td>
                  <td className="px-3"><ProjectStatusBadge status={p.status} /></td>
                  <td className="px-3 tabular-nums text-muted">{p.scenesReady}/{p.scenes}</td>
                  <td className="px-3 tabular-nums text-muted">{secs(p.narrationDurationSec)}</td>
                  <td className="px-3 tabular-nums text-muted">{usd(p.spentUsd, 2)} / {usd(p.budgetUsd, 2)}</td>
                  <td className="px-3 text-muted">{ago(p.updatedAt)}</td>
                  <td className="px-3 text-right">
                    <Button size="xs" variant="ghost" aria-label="Delete project" icon={<Trash2 className="size-3.5" />} disabled={p.activeJobs > 0}
                      title={p.activeJobs > 0 ? 'Jobs are running' : 'Delete'}
                      onClick={async (e) => { e.stopPropagation(); if (await confirm('Delete project?', `"${p.title}" will be removed from your projects. Generated files are kept on disk.`, 'Delete')) del.mutate(p.id); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
