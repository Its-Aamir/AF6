import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Copy, Eye, Film, Image as ImageIcon, Lock, LockOpen, Pause, Pencil, Play, RefreshCw, Replace, RotateCcw, Scissors, Sparkles, Upload, Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AssetThumb, aspectClass, QualityBadge, SceneStatusBadge } from '../components/common';
import { useToast } from '../components/toast';
import { Badge, Button, Empty, Modal, Progress, Segmented, Spinner } from '../components/ui';
import { api, assetUrl, thumbUrl } from '../lib/api';
import { timecode, usd } from '../lib/format';
import { useAction, useProviders } from '../lib/hooks';
import type { Asset, ProjectState, Scene } from '../lib/types';
import type { ProjectActions } from './Studio';

const UNIT: Record<string, string> = { second: 's', image: 'img', '1k_chars': '1k chars', '1k_tokens': '1k tok' };

export function StoryboardTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const [preview, setPreview] = useState<Scene | null>(null);
  const [replace, setReplace] = useState<Scene | null>(null);
  const estimate = useQuery({
    queryKey: ['estimate', p.id, state.scenes.map((s) => `${s.id}:${s.model}:${s.selectedAssetId}:${s.status}`).join()],
    queryFn: () => api.get<{ scenes: number; estimatedUsd: number }>(`/projects/${p.id}/scenes/estimate`),
    enabled: state.scenes.length > 0,
  });
  const counts = useMemo(() => ({
    generated: state.scenes.filter((s) => s.selectedAssetId).length,
    active: state.scenes.filter((s) => s.status === 'queued' || s.status === 'generating').length,
    failed: state.scenes.filter((s) => s.status === 'failed').length,
    locked: state.scenes.filter((s) => s.locked).length,
  }), [state.scenes]);
  const planned = state.scenes.some((s) => s.prompt);

  if (!state.scenes.length) {
    return (
      <div className="p-8">
        <Empty icon={<Scissors className="size-6" />} title={p.status === 'segmenting' ? 'Splitting narration into scenes…' : 'No scenes yet'}
          action={p.narrationAssetId
            ? <Button variant="primary" icon={<Scissors className="size-4" />} loading={actions.segment.isPending || p.status === 'segmenting'} disabled={p.busy} onClick={() => actions.segment.mutate()}>Split narration into scenes</Button>
            : <Button disabled>Generate narration first</Button>}>
          Scenes are cut from the narration's measured word timings, so every visual lines up with what is being said.
        </Empty>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-4 text-[12px] text-muted">
          <span><b className="text-fg tabular-nums">{state.scenes.length}</b> scenes</span>
          <span><b className="text-ok tabular-nums">{counts.generated}</b> with visuals</span>
          {counts.active > 0 && <span><b className="text-accent tabular-nums">{counts.active}</b> generating</span>}
          {counts.failed > 0 && <span><b className="text-bad tabular-nums">{counts.failed}</b> failed</span>}
          {counts.locked > 0 && <span><b className="text-fg tabular-nums">{counts.locked}</b> locked</span>}
          <span>narration {p.narrationDurationSec?.toFixed(1)}s</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModelSwitch state={state} capability="video" />
          <ModelSwitch state={state} capability="image" />
          <Button size="sm" icon={<Sparkles className="size-3.5" />} loading={actions.plan.isPending || p.status === 'planning'} disabled={p.busy || p.status === 'producing'} onClick={() => actions.plan.mutate()}>
            {planned ? 'Re-plan unlocked' : 'Plan visuals'}
          </Button>
          <Button size="sm" variant="primary" icon={<Wand2 className="size-3.5" />} loading={actions.generateAll.isPending} disabled={!planned || p.busy || !estimate.data?.scenes}
            onClick={() => actions.generateAll.mutate()} title="Generate every unlocked scene that has no visual yet">
            Generate missing ({estimate.data?.scenes ?? 0}) · {usd(estimate.data?.estimatedUsd ?? 0)}
          </Button>
        </div>
      </div>
      {p.visualStyleNotes && <p className="mb-4 text-[12px] text-muted"><span className="font-medium text-fg">Style:</span> {p.visualStyleNotes}</p>}
      <div className="space-y-3">
        {state.scenes.map((s) => <SceneCard key={s.id} scene={s} state={state} onPreview={() => setPreview(s)} onReplace={() => setReplace(s)} />)}
      </div>
      {preview && <ScenePreview state={state} scene={state.scenes.find((s) => s.id === preview.id) ?? preview} onClose={() => setPreview(null)} />}
      {replace && <ReplaceModal state={state} scene={replace} onClose={() => setReplace(null)} />}
    </div>
  );
}

function SceneCard({ scene: s, state, onPreview, onReplace }: { scene: Scene; state: ProjectState; onPreview: () => void; onReplace: () => void }) {
  const p = state.project;
  const providers = useProviders();
  const selected = s.candidates.find((c) => c.id === s.selectedAssetId) ?? null;
  const active = s.activeGenerations;
  const progress = active.length ? Math.max(...active.map((g) => g.progress)) : 0;
  const busy = s.status === 'queued' || s.status === 'generating';
  const [prompt, setPrompt] = useState(s.prompt ?? '');
  const [negative, setNegative] = useState(s.negativePrompt);
  const [refs, setRefs] = useState(s.references.join(', '));
  const [editDur, setEditDur] = useState<string | null>(null);
  useEffect(() => { setPrompt(s.prompt ?? ''); setNegative(s.negativePrompt); setRefs(s.references.join(', ')); }, [s.prompt, s.negativePrompt, s.references.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = prompt !== (s.prompt ?? '') || negative !== s.negativePrompt || refs !== s.references.join(', ');
  const o = { projectId: p.id };
  const patch = useAction((body: Record<string, unknown>) => api.patch(`/scenes/${s.id}`, body), o);
  const gen = useAction((alternatives: number) => api.post(`/scenes/${s.id}/generate`, { alternatives }), { ...o, success: 'Generation queued' });
  const select = useAction((assetId: string) => api.post(`/scenes/${s.id}/select-asset`, { assetId }), o);
  const dur = useAction((durationSec: number) => api.post(`/scenes/${s.id}/duration`, { durationSec }), { ...o, success: 'Scene boundary moved' });
  const cap = s.visualStrategy === 'ai_video' ? 'video' : 'image';
  const modelOptions = (providers.data ?? []).filter((pr) => pr.capabilities.includes(cap)).flatMap((pr) =>
    pr.implemented && pr.configured ? pr.models.filter((m) => m.capability === cap).map((m) => ({ value: `${pr.id}::${m.id}`, label: `${m.label.replace(/^Mock /, '')} · ${usd(m.unitCostUsd, 2)}/${UNIT[m.unit] ?? m.unit}`, disabled: false }))
      : [{ value: `${pr.id}::`, label: `${pr.displayName} — not connected (Providers page)`, disabled: true }]);
  const canEdit = !s.locked && !busy && s.status !== 'pending';
  const lockedReason = s.locked ? 'Scene is locked' : busy ? 'Generation in progress' : undefined;

  return (
    <article id={`scene-${s.index}`} className={clsx('grid grid-cols-[300px_1fr_252px] overflow-hidden rounded-xl border bg-panel transition-colors', s.locked ? 'border-accent/30' : s.status === 'failed' ? 'border-bad/30' : 'border-line')}>
      {/* Visual */}
      <div className="relative border-r border-line bg-black">
        <button onClick={onPreview} className="block w-full" aria-label={`Preview scene ${s.index}`}>
          <AssetThumb asset={selected} className={clsx(aspectClass(p.recipeSnapshot.aspectRatio), 'w-full', p.recipeSnapshot.aspectRatio === '9:16' && 'mx-auto max-h-[300px] w-auto')} fit={p.recipeSnapshot.aspectRatio === '9:16' ? 'contain' : 'cover'} />
        </button>
        {busy && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pt-8">
            <div className="shimmer absolute inset-0" />
            <div className="relative flex justify-between text-[11px] text-fg"><span>{s.status === 'queued' ? 'Queued' : `Generating${active.length > 1 ? ` ${active.length} variants` : ''}`}</span><span className="tabular-nums">{Math.round(progress * 100)}%</span></div>
            <Progress className="relative mt-1" value={progress} />
          </div>
        )}
        {s.candidates.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto border-t border-line bg-panel-2 p-1.5">
            {s.candidates.map((c) => (
              <button key={c.id} disabled={s.locked} onClick={() => c.id !== s.selectedAssetId && select.mutate(c.id)} title={s.locked ? 'Scene is locked' : `Use: ${c.label}`}
                className={clsx('relative h-10 w-16 shrink-0 overflow-hidden rounded border-2', c.id === s.selectedAssetId ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100')}>
                <AssetThumb asset={c} className="size-full" playOnHover={false} />
                {c.mediaType === 'video' && <Film className="absolute right-0.5 bottom-0.5 size-2.5 text-white drop-shadow" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Details */}
      <div className="min-w-0 space-y-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold tabular-nums">Scene {String(s.index).padStart(2, '0')}</span>
          <span className="font-mono text-[11px] text-muted">{timecode(s.startSec)} → {timecode(s.endSec)}</span>
          {editDur === null ? (
            <button className="flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[11px] tabular-nums text-fg hover:border-line-strong disabled:opacity-50" disabled={!!lockedReason} title={lockedReason ?? 'Change duration (moves the boundary with the next scene, snapped to words)'} onClick={() => setEditDur(s.durationSec.toFixed(1))}>
              {s.durationSec.toFixed(1)}s <Pencil className="size-2.5 text-muted" />
            </button>
          ) : (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const v = Number(editDur); if (v > 0) dur.mutate(v, { onSettled: () => setEditDur(null) }); }}>
              <input autoFocus type="number" step={0.1} min={0.5} className="input w-20 py-0.5 text-[12px]" value={editDur} onChange={(e) => setEditDur(e.target.value)} />
              <Button size="xs" type="submit" loading={dur.isPending}>Apply</Button>
              <Button size="xs" variant="ghost" type="button" onClick={() => setEditDur(null)}>Cancel</Button>
            </form>
          )}
          <SceneStatusBadge status={s.status} />
          <QualityBadge status={s.qualityStatus} notes={s.qualityNotes} />
          {s.locked && <Badge tone="accent"><Lock className="size-3" />Locked</Badge>}
        </div>
        <p className="text-[13px] leading-relaxed text-fg/90">“{s.narration}”</p>
        {s.error && <div className="flex items-start gap-1.5 rounded-md bg-bad/8 px-2 py-1.5 text-[11px] text-bad"><AlertTriangle className="mt-px size-3 shrink-0" />{s.error}</div>}
        {s.status === 'pending' ? (
          <div className="rounded-lg border border-dashed border-line p-3 text-[12px] text-muted">No visual brief yet — run <b>Plan visuals</b> to create prompts for every scene.</div>
        ) : (
          <>
            <div>
              <div className="mb-1 flex items-center justify-between"><span className="label mb-0">Prompt</span>{s.brief && <span className="text-[10px] text-faint">{s.brief.shotType.replace('_', ' ')} · {s.brief.camera.replaceAll('_', ' ')} · {s.brief.mood}</span>}</div>
              <textarea className="input min-h-[64px] text-[12px]" value={prompt} disabled={!canEdit} onChange={(e) => setPrompt(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label><span className="label">Negative</span><input className="input py-1 text-[12px]" value={negative} disabled={!canEdit} onChange={(e) => setNegative(e.target.value)} /></label>
              <label><span className="label">References</span><input className="input py-1 text-[12px]" placeholder="comma-separated notes or URLs" value={refs} disabled={!canEdit} onChange={(e) => setRefs(e.target.value)} /></label>
            </div>
            {dirty && (
              <div className="flex gap-2">
                <Button size="xs" variant="primary" loading={patch.isPending} disabled={prompt.trim().length < 8}
                  onClick={() => patch.mutate({ prompt, negativePrompt: negative, references: refs.split(',').map((r) => r.trim()).filter(Boolean) })}>Save prompt</Button>
                <Button size="xs" variant="ghost" onClick={() => { setPrompt(s.prompt ?? ''); setNegative(s.negativePrompt); setRefs(s.references.join(', ')); }}><RotateCcw className="size-3" />Revert</Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2.5 border-l border-line bg-panel-2/50 p-3">
        <Segmented size="sm" value={s.visualStrategy ?? 'ai_image'} disabled={!canEdit}
          onChange={(v) => patch.mutate({ visualStrategy: v })}
          options={[{ value: 'ai_image', label: <span className="flex items-center gap-1"><ImageIcon className="size-3" />Image</span> }, { value: 'ai_video', label: <span className="flex items-center gap-1"><Film className="size-3" />Video</span> }]} />
        <label>
          <span className="label">Model</span>
          <select className="input py-1 text-[12px]" disabled={!canEdit} value={`${s.provider}::${s.model}`}
            onChange={(e) => { const [provider, model] = e.target.value.split('::'); if (model) patch.mutate({ provider, model }); }}>
            {!modelOptions.some((m) => m.value === `${s.provider}::${s.model}`) && <option value={`${s.provider}::${s.model}`}>{s.model ?? '—'}</option>}
            {modelOptions.map((m) => <option key={m.value} value={m.value} disabled={m.disabled}>{m.label}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-1 text-[11px] text-muted">
          <span>Provider</span><span className="text-right text-fg">{s.provider ?? '—'}</span>
          <span>Scene cost</span><span className="text-right tabular-nums text-fg">{usd(s.costUsd)}</span>
          <span>Variants</span><span className="text-right tabular-nums text-fg">{s.candidates.length}</span>
        </div>
        <div className="mt-auto grid grid-cols-2 gap-1.5">
          <Button size="sm" variant={selected ? 'secondary' : 'primary'} className="col-span-2" disabled={!canEdit} loading={gen.isPending}
            icon={selected ? <RefreshCw className="size-3.5" /> : <Wand2 className="size-3.5" />} title={lockedReason} onClick={() => gen.mutate(1)}>{selected ? 'Regenerate' : 'Generate'}</Button>
          <Button size="xs" disabled={!canEdit} icon={<Copy className="size-3" />} title="Generate 2 alternatives to choose from" onClick={() => gen.mutate(2)}>Alternatives</Button>
          <Button size="xs" disabled={s.locked || s.status === 'pending'} icon={<Replace className="size-3" />} onClick={onReplace}>Replace</Button>
          <Button size="xs" disabled={!selected} icon={<Eye className="size-3" />} onClick={onPreview}>Preview</Button>
          <Button size="xs" variant={s.locked ? 'subtle' : 'secondary'} icon={s.locked ? <LockOpen className="size-3" /> : <Lock className="size-3" />} loading={patch.isPending && patch.variables?.locked !== undefined}
            onClick={() => patch.mutate({ locked: !s.locked })}>{s.locked ? 'Unlock' : 'Lock'}</Button>
        </div>
      </div>
    </article>
  );
}

/** Scene preview: the scene's visual with its slice of the narration and live captions. */
export function ScenePreview({ state, scene, onClose }: { state: ProjectState; scene: Scene; onClose: () => void }) {
  const p = state.project;
  const audio = useRef<HTMLAudioElement>(null);
  const [t, setT] = useState(scene.startSec);
  const [playing, setPlaying] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const selected = scene.candidates.find((c) => c.id === scene.selectedAssetId) ?? null;
  const cues = p.captions.cues.length ? p.captions.cues : null;
  const words = (p.narrationWords ?? []).slice(scene.wordStart, scene.wordEnd);
  const caption = cues ? cues.find((c) => t >= c.start && t < c.end)?.text : words.filter((w) => w.start <= t).slice(-7).map((w) => w.word).join(' ');
  const dur = scene.endSec - scene.startSec;

  const play = () => {
    const a = audio.current;
    if (!a) return;
    if (a.currentTime < scene.startSec || a.currentTime >= scene.endSec - 0.05) { a.currentTime = scene.startSec; setEpoch((e) => e + 1); }
    void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audio.current;
      if (a) {
        setT(a.currentTime);
        if (a.currentTime >= scene.endSec) { a.pause(); setPlaying(false); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene.endSec]);

  return (
    <Modal open onClose={onClose} wide title={`Scene ${scene.index} preview · ${timecode(scene.startSec)}–${timecode(scene.endSec)}`}>
      <div className={clsx('relative mx-auto overflow-hidden rounded-lg bg-black', aspectClass(p.recipeSnapshot.aspectRatio), p.recipeSnapshot.aspectRatio === '9:16' ? 'h-[62vh]' : 'w-full')}>
        {selected?.mediaType === 'image' && <img key={epoch} src={assetUrl(selected.id)} alt="" className={clsx('size-full object-cover', playing && 'kenburns')} style={{ animationDuration: `${dur}s` }} />}
        {selected?.mediaType === 'video' && <video src={assetUrl(selected.id)} poster={thumbUrl(selected.id)} muted loop autoPlay playsInline className="size-full object-cover" />}
        {caption && p.captions.enabled !== false && (
          <div className={clsx('absolute inset-x-0 px-10 text-center', p.captions.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[8%]')}>
            <span className="rounded-md bg-black/55 px-2 py-1 text-[18px] font-semibold text-white [text-shadow:0_2px_4px_#000]">{caption}</span>
          </div>
        )}
        <div className="absolute top-2 left-2"><Badge>{cues ? 'Captions' : 'Narration words'}</Badge></div>
      </div>
      {p.narrationAssetId && <audio ref={audio} src={assetUrl(p.narrationAssetId)} preload="auto" onPause={() => setPlaying(false)} />}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => (playing ? audio.current?.pause() : play())} icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}>{playing ? 'Pause' : 'Play scene'}</Button>
        <Progress className="flex-1" value={(t - scene.startSec) / dur} />
        <span className="font-mono text-[11px] text-muted">{timecode(Math.max(0, t - scene.startSec))} / {timecode(dur)}</span>
      </div>
      <p className="mt-3 text-[12px] text-muted">{scene.narration}</p>
    </Modal>
  );
}

function ReplaceModal({ state, scene, onClose }: { state: ProjectState; scene: Scene; onClose: () => void }) {
  const p = state.project;
  const lib = useQuery({ queryKey: ['assets', 'replace', p.id], queryFn: () => api.get<Asset[]>(`/assets?projectId=${p.id}`) });
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const select = useAction((assetId: string) => api.post(`/scenes/${scene.id}/select-asset`, { assetId }).then(onClose), { projectId: p.id, success: `Scene ${scene.index} visual replaced` });
  const options = (lib.data ?? []).filter((a) => (a.mediaType === 'image' || a.mediaType === 'video') && a.id !== scene.selectedAssetId);
  async function upload(f: File) {
    setUploading(true);
    try {
      await api.upload(`/assets/upload?projectId=${p.id}&sceneId=${scene.id}`, f);
      toast('ok', `Scene ${scene.index} visual replaced with ${f.name}`);
      await qc.invalidateQueries({ queryKey: ['project', p.id] });
      onClose();
    } catch (e) { toast('error', 'Upload rejected', (e as Error).message); } finally { setUploading(false); }
  }
  return (
    <Modal open onClose={onClose} wide title={`Replace visual · Scene ${scene.index}`}
      footer={<><input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button variant="primary" icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => input.current?.click()}>Upload file…</Button></>}>
      <p className="mb-3 text-[12px] text-muted">Pick any image or video from this project or the library, or upload your own (validated with ffprobe; PNG, JPG, WebP, MP4, MOV, WebM).</p>
      {lib.isLoading ? <Spinner /> : options.length === 0 ? <div className="py-8 text-center text-muted">No other visuals available — upload one.</div> : (
        <div className="grid grid-cols-4 gap-2">
          {options.map((a) => (
            <button key={a.id} onClick={() => select.mutate(a.id)} className="overflow-hidden rounded-lg border border-line text-left hover:border-accent">
              <AssetThumb asset={a} className="aspect-video" />
              <div className="truncate p-1.5 text-[11px] text-muted">{a.label || a.kind}</div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Project-level model choice: applies to every unlocked scene of that kind and becomes the project default. */
function ModelSwitch({ state, capability }: { state: ProjectState; capability: 'image' | 'video' }) {
  const p = state.project;
  const providers = useProviders();
  const { toast } = useToast();
  const current = p.recipeSnapshot.defaults[capability];
  const options = (providers.data ?? []).filter((pr) => pr.implemented && pr.configured).flatMap((pr) =>
    pr.models.filter((m) => m.capability === capability).map((m) => ({ value: `${pr.id}::${m.id}`, label: `${pr.transport === 'mock' ? 'Mock · ' : `${pr.displayName} · `}${m.label.replace(/^Mock /, '')}${m.unitCostUsd == null ? ' (set price)' : ''}` })));
  const apply = useAction((v: string) => {
    const [provider, model] = v.split('::');
    return api.post<{ updatedScenes: number }>(`/projects/${p.id}/scenes/model`, { capability, provider, model }).then((r) => { toast('ok', `${capability === 'video' ? 'Video' : 'Image'} model updated`, `${r.updatedScenes} unlocked scene(s) switched.`); return r; });
  }, { projectId: p.id });
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-muted" title={`Model for all unlocked ${capability} scenes`}>
      {capability === 'video' ? <Film className="size-3.5" /> : <ImageIcon className="size-3.5" />}
      <select className="input w-52 py-1 text-[12px]" disabled={p.busy || apply.isPending} value={`${current.provider}::${current.model}`} onChange={(e) => apply.mutate(e.target.value)}>
        {!options.some((o) => o.value === `${current.provider}::${current.model}`) && <option value={`${current.provider}::${current.model}`}>{current.model} (unavailable)</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
