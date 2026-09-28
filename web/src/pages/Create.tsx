import clsx from 'clsx';
import { FileText, Lightbulb, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../components/toast';
import { Button, ErrorNote, Field, PageHeader, Panel, Segmented, Spinner, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useRecipes } from '../lib/hooks';
import type { Project, Settings } from '../lib/types';

export function CreatePage() {
  const recipes = useRecipes();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const nav = useNavigate();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'topic' | 'script'>('topic');
  const [topic, setTopic] = useState('');
  const [script, setScript] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [budget, setBudget] = useState<number | ''>('');
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!recipeId && recipes.data?.length) setRecipeId(recipes.data[0].id); }, [recipes.data, recipeId]);
  useEffect(() => { if (budget === '' && settings.data) setBudget(settings.data.defaultBudgetUsd); }, [settings.data, budget]);

  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const recipe = recipes.data?.find((r) => r.id === recipeId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<Project>('/projects', { title: title || (mode === 'topic' ? topic.slice(0, 80) : 'Untitled script'), inputMode: mode, topic, sourceScript: script, recipeId, budgetUsd: budget === '' ? undefined : budget });
      if (autoStart) {
        try { await api.post(`/projects/${p.id}/script/generate`, {}); } catch (err) { toast('error', 'Project created, but script generation did not start', (err as Error).message); }
      }
      nav(`/projects/${p.id}/script`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px] p-8">
      <PageHeader title="Create a video" subtitle="Start from a topic or your own script. The narration becomes the master timeline." />
      <form onSubmit={submit} className="grid grid-cols-[1fr_360px] gap-6">
        <div className="space-y-5">
          <Panel title="Input">
            <div className="space-y-4">
              <Field label="Project title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The Lost Library of Alexandria" maxLength={140} /></Field>
              <div>
                <span className="label">Start from</span>
                <Segmented value={mode} onChange={setMode} options={[{ value: 'topic', label: <span className="flex items-center gap-1.5"><Lightbulb className="size-3.5" />Topic</span> }, { value: 'script', label: <span className="flex items-center gap-1.5"><FileText className="size-3.5" />My script</span> }]} />
              </div>
              {mode === 'topic' ? (
                <Field label="Topic" hint="The mock LLM writes a structured script following the recipe's sections, tone and target length.">
                  <textarea className="input min-h-[110px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is the video about?" maxLength={1000} />
                </Field>
              ) : (
                <Field label="Script" hint={`${words} words · kept verbatim as narration. Separate sections with a blank line.`}>
                  <textarea className="input min-h-[260px] font-[450]" value={script} onChange={(e) => setScript(e.target.value)} placeholder="Paste your narration script…" maxLength={20000} />
                </Field>
              )}
            </div>
          </Panel>
          {error && <ErrorNote onDismiss={() => setError(null)}>{error}</ErrorNote>}
        </div>
        <div className="space-y-5">
          <Panel title="Channel Recipe" bodyClassName="p-2">
            {recipes.isLoading ? <Spinner /> : (
              <div className="space-y-1.5">
                {recipes.data?.map((r) => (
                  <button type="button" key={r.id} onClick={() => setRecipeId(r.id)}
                    className={clsx('w-full rounded-lg border p-3 text-left transition-colors', recipeId === r.id ? 'border-accent/60 bg-accent/8' : 'border-transparent hover:bg-raised')}>
                    <div className="flex items-center justify-between"><span className="font-medium">{r.name}</span><span className="text-[11px] text-muted">{r.config.aspectRatio} · {r.config.targetDurationSec}s</span></div>
                    <div className="mt-1 line-clamp-2 text-[12px] text-muted">{r.description}</div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
          {recipe && (
            <div className="rounded-xl border border-line bg-panel p-4 text-[12px] text-muted">
              <div className="grid grid-cols-2 gap-y-1.5">
                <span>Pacing</span><span className="text-fg">{recipe.config.wordsPerMinute} wpm</span>
                <span>Scenes</span><span className="text-fg">{recipe.config.minSceneSec}–{recipe.config.maxSceneSec}s</span>
                <span>Video share</span><span className="text-fg">{Math.round(recipe.config.videoRatio * 100)}%</span>
                <span>Voice</span><span className="text-fg">{recipe.config.voiceId}</span>
              </div>
            </div>
          )}
          <Panel title="Budget">
            <Field label="Project budget (USD)" hint="Generation is refused if it would exceed this."><input type="number" min={0} step={0.5} className="input" value={budget} onChange={(e) => setBudget(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
            <div className="mt-4"><Toggle checked={autoStart} onChange={setAutoStart} label="Generate the script right away" /></div>
          </Panel>
          <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<Wand2 className="size-4" />} disabled={!recipeId || (mode === 'topic' ? topic.trim().length < 3 : words < 10)}>Create project</Button>
        </div>
      </form>
    </div>
  );
}
