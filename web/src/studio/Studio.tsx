import clsx from 'clsx';
import { AlertTriangle, ArrowRight, Check, ChevronLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { isStepComplete, PIPELINE } from '../../../src/shared/stateMachines';
import { ProjectStatusBadge } from '../components/common';
import { Button, ErrorNote, Progress, Spinner } from '../components/ui';
import { api, downloadUrl } from '../lib/api';
import { usd } from '../lib/format';
import { useAction, useProject } from '../lib/hooks';
import type { ProjectState } from '../lib/types';
import { AssetsTab } from './AssetsTab';
import { AudioTab } from './AudioTab';
import { PublishTab } from './PublishTab';
import { QaTab } from './QaTab';
import { ScriptTab } from './ScriptTab';
import { StoryboardTab } from './StoryboardTab';
import { TimelineTab } from './TimelineTab';

const TABS = [
  { id: 'script', label: 'Script' }, { id: 'storyboard', label: 'Storyboard' }, { id: 'assets', label: 'Assets' },
  { id: 'timeline', label: 'Timeline' }, { id: 'audio', label: 'Audio' }, { id: 'qa', label: 'QA' }, { id: 'publish', label: 'Publish' },
] as const;

const STEP_TAB: Record<string, string> = { script: 'script', narration: 'audio', segment: 'storyboard', plan: 'storyboard', assets: 'storyboard', assemble: 'timeline', qa: 'qa', render: 'publish' };

/** All pipeline actions for a project; each hits a real endpoint and reports errors. */
export function useProjectActions(id: string) {
  const o = { projectId: id };
  return {
    script: useAction((_: void, c) => api.post(`/projects/${id}/script/generate`, { confirmReset: c }), { ...o, success: 'Script generation started' }),
    narration: useAction((_: void, c) => api.post(`/projects/${id}/narration/generate`, { confirmReset: c }), { ...o, success: 'Narration generation started' }),
    segment: useAction((_: void, c) => api.post(`/projects/${id}/scenes/segment`, { confirmReset: c }), { ...o, success: 'Splitting narration into scenes' }),
    plan: useAction(() => api.post(`/projects/${id}/visuals/plan`), { ...o, success: 'Visual planning started' }),
    generateAll: useAction(() => api.post(`/projects/${id}/scenes/generate-all`), { ...o, success: 'Scene generation queued' }),
    assemble: useAction(() => api.post(`/projects/${id}/timeline/assemble`), { ...o, success: 'Timeline assembled' }),
    captions: useAction(() => api.post(`/projects/${id}/captions/generate`), { ...o, success: 'Captions generated' }),
    music: useAction(() => api.post(`/projects/${id}/music/generate`), { ...o, success: 'Music generation started' }),
    qa: useAction(() => api.post(`/projects/${id}/qa/run`), { ...o, success: 'QA started' }),
    render: useAction((preset: 'draft' | 'final') => api.post(`/projects/${id}/render`, { preset }), { ...o, success: 'Render started' }),
    pkg: useAction(() => api.post(`/projects/${id}/package`), { ...o, success: 'Packaging project' }),
  };
}
export type ProjectActions = ReturnType<typeof useProjectActions>;

function NextStep({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const nav = useNavigate();
  const p = state.project;
  const go = (tab: string) => nav(`/projects/${p.id}/${tab}`);
  const map: Record<string, { label: string; run: () => void; pending?: boolean }> = {
    draft: { label: 'Generate script', run: () => { actions.script.mutate(); go('script'); }, pending: actions.script.isPending },
    scripted: { label: 'Generate narration', run: () => actions.narration.mutate(), pending: actions.narration.isPending },
    narrated: { label: 'Split into scenes', run: () => { actions.segment.mutate(); go('storyboard'); }, pending: actions.segment.isPending },
    segmented: { label: 'Plan visuals', run: () => { actions.plan.mutate(); go('storyboard'); }, pending: actions.plan.isPending },
    planned: { label: 'Generate all visuals', run: () => { actions.generateAll.mutate(); go('storyboard'); }, pending: actions.generateAll.isPending },
    assets_ready: { label: 'Assemble timeline', run: () => { actions.assemble.mutate(); go('timeline'); }, pending: actions.assemble.isPending },
    assembled: { label: 'Run QA', run: () => { actions.qa.mutate(); go('qa'); }, pending: actions.qa.isPending },
    qa_failed: { label: 'Review QA issues', run: () => go('qa') },
    qa_passed: { label: 'Render video', run: () => { actions.render.mutate('final'); go('publish'); }, pending: actions.render.isPending },
  };
  if (p.status === 'rendered' && p.finalRenderAssetId) return <a href={downloadUrl(p.finalRenderAssetId)}><Button variant="primary">Download MP4</Button></a>;
  const step = map[p.status];
  if (!step) return <Button variant="primary" disabled icon={<Loader2 className="size-3.5 animate-spin" />}>{p.status === 'producing' ? 'Generating visuals…' : 'Working…'}</Button>;
  return <Button variant="primary" onClick={step.run} loading={step.pending} icon={<ArrowRight className="size-3.5" />}>{step.label}</Button>;
}

export function Studio() {
  const { id = '', tab = 'storyboard' } = useParams();
  const q = useProject(id);
  const actions = useProjectActions(id);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (q.isLoading) return <div className="p-8"><Spinner /></div>;
  if (q.error || !q.data) return <div className="p-8"><ErrorNote>{(q.error as Error)?.message ?? 'Project not found'}</ErrorNote><Link to="/projects"><Button className="mt-4">Back to projects</Button></Link></div>;
  const state = q.data;
  const p = state.project;
  const busyJob = state.jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const budgetUsed = (state.costs.spentUsd + state.costs.pendingUsd) / Math.max(0.0001, state.costs.budgetUsd);
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-panel">
        <div className="flex items-center gap-4 px-5 pt-3.5">
          <Link to="/projects" className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label="Back to projects"><ChevronLeft className="size-4" /></Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h1 className="truncate text-[15px] font-semibold">{p.title}</h1>
              <ProjectStatusBadge status={p.status} />
            </div>
            <div className="mt-0.5 text-[11px] text-muted">{p.recipeName} · {p.recipeSnapshot.aspectRatio} · {p.narrationDurationSec ? `${p.narrationDurationSec.toFixed(1)}s narration` : 'no narration yet'} · {state.scenes.length} scenes</div>
          </div>
          <div className="w-44 text-[11px]">
            <div className="flex justify-between text-muted"><span>Budget</span><span className="tabular-nums text-fg">{usd(state.costs.spentUsd, 3)} / {usd(state.costs.budgetUsd, 2)}</span></div>
            <Progress className="mt-1" value={budgetUsed} tone={budgetUsed > 0.9 ? 'warn' : 'accent'} />
            {state.costs.pendingUsd > 0 && <div className="mt-0.5 text-faint">+{usd(state.costs.pendingUsd)} in flight</div>}
          </div>
          {busyJob && (
            <div className="w-52 text-[11px]">
              <div className="flex justify-between text-muted"><span>{state.activeJobs} active job{state.activeJobs === 1 ? '' : 's'}</span><span className="tabular-nums">{Math.round(busyJob.progress * 100)}%</span></div>
              <Progress className="mt-1" value={busyJob.progress} />
              <div className="mt-0.5 truncate text-faint">{busyJob.progressMessage ?? 'Queued'}</div>
            </div>
          )}
          <NextStep state={state} actions={actions} />
        </div>
        <ol className="flex items-center gap-1 px-5 pt-3">
          {PIPELINE.map((s, i) => {
            const done = isStepComplete(p.status, s.step);
            const running = (p.status === 'scripting' && s.step === 'script') || (p.status === 'narrating' && s.step === 'narration') || (p.status === 'segmenting' && s.step === 'segment') || (p.status === 'planning' && s.step === 'plan') || (p.status === 'producing' && s.step === 'assets') || (p.status === 'qa_running' && s.step === 'qa') || (p.status === 'rendering' && s.step === 'render');
            return (
              <li key={s.step} className="flex items-center gap-1">
                <Link to={`/projects/${p.id}/${STEP_TAB[s.step]}`} className={clsx('flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  done ? 'text-ok hover:bg-ok/10' : running ? 'bg-accent/12 text-accent-strong' : 'text-faint hover:text-muted')}>
                  <span className={clsx('grid size-4 place-items-center rounded-full border text-[9px]', done ? 'border-ok/50 bg-ok/15' : running ? 'border-accent/60' : 'border-line-strong')}>
                    {done ? <Check className="size-2.5" /> : running ? <Loader2 className="size-2.5 animate-spin" /> : i + 1}
                  </span>
                  {s.label}
                </Link>
                {i < PIPELINE.length - 1 && <span className="h-px w-4 bg-line-strong" />}
              </li>
            );
          })}
        </ol>
        <nav className="mt-2 flex gap-1 px-4">
          {TABS.map((t) => (
            <NavLink key={t.id} to={`/projects/${p.id}/${t.id}`} className={({ isActive }) => clsx('border-b-2 px-3 py-2 text-[13px] font-medium transition-colors', isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      {p.lastError && dismissed !== p.lastError && (
        <div className="shrink-0 px-5 pt-3"><ErrorNote onDismiss={() => setDismissed(p.lastError)}><AlertTriangle className="mr-1.5 inline size-3.5" />{p.lastError}</ErrorNote></div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'script' && <ScriptTab state={state} actions={actions} />}
        {tab === 'storyboard' && <StoryboardTab state={state} actions={actions} />}
        {tab === 'assets' && <AssetsTab state={state} />}
        {tab === 'timeline' && <TimelineTab state={state} actions={actions} />}
        {tab === 'audio' && <AudioTab state={state} actions={actions} />}
        {tab === 'qa' && <QaTab state={state} actions={actions} />}
        {tab === 'publish' && <PublishTab state={state} actions={actions} />}
        {!TABS.some((t) => t.id === tab) && <div className="p-8 text-muted">Unknown tab.</div>}
      </div>
    </div>
  );
}
