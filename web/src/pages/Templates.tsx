import clsx from 'clsx';
import { Copy, Lock, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../components/toast';
import { Badge, Button, ErrorNote, Field, PageHeader, Panel, Spinner, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAction, useProviders, useRecipes, useVoices } from '../lib/hooks';
import type { Recipe, RecipeConfig } from '../lib/types';

export function TemplatesPage() {
  const recipes = useRecipes();
  const [selected, setSelected] = useState<string | null>(null);
  const current = recipes.data?.find((r) => r.id === selected) ?? recipes.data?.[0];
  const dup = useAction((id: string) => api.post<Recipe>(`/recipes/${id}/duplicate`).then((r) => { setSelected(r.id); return r; }), { success: 'Recipe duplicated', invalidate: [['recipes']] });
  return (
    <div className="mx-auto max-w-[1280px] p-8">
      <PageHeader title="Channel Recipes" subtitle="Reusable production presets: format, pacing, style, providers, captions and music." />
      {recipes.isLoading ? <Spinner /> : (
        <div className="grid grid-cols-[300px_1fr] gap-6">
          <div className="space-y-1.5">
            {recipes.data?.map((r) => (
              <button key={r.id} onClick={() => setSelected(r.id)} className={clsx('w-full rounded-lg border p-3 text-left', current?.id === r.id ? 'border-accent/50 bg-accent/8' : 'border-line bg-panel hover:border-line-strong')}>
                <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{r.name}</span>{r.builtIn && <Badge><Lock className="size-3" />Built-in</Badge>}</div>
                <div className="mt-1 text-[11px] text-muted">{r.config.aspectRatio} · {r.config.targetDurationSec}s · {r.config.wordsPerMinute} wpm</div>
              </button>
            ))}
          </div>
          {current && <RecipeEditor key={current.id + current.updatedAt} recipe={current} onDuplicate={() => dup.mutate(current.id)} onDeleted={() => setSelected(null)} />}
        </div>
      )}
    </div>
  );
}

function RecipeEditor({ recipe, onDuplicate, onDeleted }: { recipe: Recipe; onDuplicate: () => void; onDeleted: () => void }) {
  const providers = useProviders();
  const voices = useVoices();
  const { confirm } = useToast();
  const [name, setName] = useState(recipe.name);
  const [description, setDescription] = useState(recipe.description);
  const [c, setC] = useState<RecipeConfig>(recipe.config);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [recipe.id]);
  const ro = recipe.builtIn;
  const set = <K extends keyof RecipeConfig>(k: K, v: RecipeConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const save = useAction(async () => {
    setError(null);
    try { return await api.put(`/recipes/${recipe.id}`, { name, description, config: c }); } catch (e) { setError((e as ApiError).message); throw e; }
  }, { success: 'Recipe saved', invalidate: [['recipes']] });
  const del = useAction(() => api.del(`/recipes/${recipe.id}`).then(onDeleted), { success: 'Recipe deleted', invalidate: [['recipes']] });
  const modelsFor = (cap: string) => (providers.data ?? []).filter((p) => p.implemented && p.configured).flatMap((p) => p.models.filter((m) => m.capability === cap).map((m) => ({ value: `${p.id}::${m.id}`, label: `${p.displayName} · ${m.label}` })));
  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <Panel title={<span className="flex items-center gap-2">{recipe.name}{ro && <Badge>Read-only</Badge>}</span>}
      actions={<>
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={onDuplicate}>Duplicate</Button>
        {!ro && <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={async () => { if (await confirm('Delete recipe?', 'Existing projects keep their own copy of the recipe settings.', 'Delete')) del.mutate(); }}>Delete</Button>}
        {!ro && <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}
      </>}>
      {ro && <div className="mb-4 rounded-lg border border-line bg-bg px-3 py-2 text-[12px] text-muted">Built-in recipes are protected. Duplicate this recipe to customise it.</div>}
      {error && <div className="mb-4"><ErrorNote onDismiss={() => setError(null)}>{error}</ErrorNote></div>}
      <fieldset disabled={ro} className="grid grid-cols-2 gap-x-5 gap-y-4">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Aspect ratio">
          <select className="input" value={c.aspectRatio} onChange={(e) => set('aspectRatio', e.target.value as RecipeConfig['aspectRatio'])}>{['16:9', '9:16', '1:1'].map((a) => <option key={a}>{a}</option>)}</select>
        </Field>
        <Field label="Description" className="col-span-2"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Target duration (s)"><input type="number" className="input" value={c.targetDurationSec} onChange={(e) => set('targetDurationSec', num(e.target.value))} /></Field>
        <Field label="Words per minute"><input type="number" className="input" value={c.wordsPerMinute} onChange={(e) => set('wordsPerMinute', num(e.target.value))} /></Field>
        <Field label="Min scene length (s)"><input type="number" step={0.5} className="input" value={c.minSceneSec} onChange={(e) => set('minSceneSec', num(e.target.value))} /></Field>
        <Field label="Max scene length (s)"><input type="number" step={0.5} className="input" value={c.maxSceneSec} onChange={(e) => set('maxSceneSec', num(e.target.value))} /></Field>
        <Field label="Tone"><input className="input" value={c.tone} onChange={(e) => set('tone', e.target.value)} /></Field>
        <Field label="Audience"><input className="input" value={c.audience} onChange={(e) => set('audience', e.target.value)} /></Field>
        <Field label="Visual style" className="col-span-2"><textarea className="input" rows={2} value={c.visualStyle} onChange={(e) => set('visualStyle', e.target.value)} /></Field>
        <Field label="Negative prompt" className="col-span-2"><input className="input" value={c.negativePrompt} onChange={(e) => set('negativePrompt', e.target.value)} /></Field>
        <Field label={`Video share: ${Math.round(c.videoRatio * 100)}% of scenes`}><input type="range" min={0} max={1} step={0.05} className="w-full" value={c.videoRatio} onChange={(e) => set('videoRatio', Number(e.target.value))} /></Field>
        <Field label="Script structure (one section per line)"><textarea className="input" rows={4} value={c.structure.join('\n')} onChange={(e) => set('structure', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} /></Field>
        {(['image', 'video', 'tts', 'music'] as const).map((cap) => (
          <Field key={cap} label={`Default ${cap} model`}>
            <select className="input" value={`${c.defaults[cap].provider}::${c.defaults[cap].model}`} onChange={(e) => { const [provider, model] = e.target.value.split('::'); set('defaults', { ...c.defaults, [cap]: { provider, model } }); }}>
              {modelsFor(cap).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        ))}
        <Field label="Voice">
          <select className="input" value={c.voiceId} onChange={(e) => set('voiceId', e.target.value)}>{voices.data?.map((v) => <option key={v.id} value={v.id}>{v.label} ({v.providerName})</option>)}</select>
        </Field>
        <Field label="Music mood"><input className="input" value={c.music.mood} onChange={(e) => set('music', { ...c.music, mood: e.target.value })} /></Field>
        <div className="col-span-2 flex flex-wrap items-center gap-6 rounded-lg border border-line p-3">
          <Toggle checked={c.captions.enabled} onChange={(v) => set('captions', { ...c.captions, enabled: v })} label="Captions" disabled={ro} />
          <label className="flex items-center gap-2 text-[12px]">Position
            <select className="input w-28" value={c.captions.position} onChange={(e) => set('captions', { ...c.captions, position: e.target.value as 'bottom' })}><option value="bottom">Bottom</option><option value="center">Center</option></select>
          </label>
          <label className="flex items-center gap-2 text-[12px]">Max chars <input type="number" className="input w-20" value={c.captions.maxChars} onChange={(e) => set('captions', { ...c.captions, maxChars: num(e.target.value) })} /></label>
          <Toggle checked={c.music.enabled} onChange={(v) => set('music', { ...c.music, enabled: v })} label="Music" disabled={ro} />
          <label className="flex items-center gap-2 text-[12px]">Music volume <input type="range" min={0} max={1} step={0.05} value={c.music.volume} onChange={(e) => set('music', { ...c.music, volume: Number(e.target.value) })} /> {Math.round(c.music.volume * 100)}%</label>
        </div>
      </fieldset>
      {!ro && save.isError && <div className="mt-3 text-[12px] text-muted">Fix the highlighted issue and save again.</div>}
    </Panel>
  );
}
