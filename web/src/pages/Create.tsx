import clsx from 'clsx';
import { FileAudio, FileText, Lightbulb, Music2, Rocket, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useToast } from '../components/toast';
import { Badge, Button, ErrorNote, Field, PageHeader, Panel, Segmented, Spinner, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useProviders, useRecipes, useVoices } from '../lib/hooks';
import type { Project, Settings } from '../lib/types';

function FilePick({ label, hint, file, onFile, icon, accept }: { label: string; hint: string; file: File | null; onFile: (f: File | null) => void; icon: React.ReactNode; accept: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div>
      <span className="label">{label}</span>
      <input ref={ref} type="file" hidden accept={accept} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      {file ? (
        <div className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-[12px]">
          {icon}<span className="flex-1 truncate">{file.name}</span><span className="text-faint">{(file.size / 1e6).toFixed(1)} MB</span>
          <button type="button" onClick={() => { onFile(null); if (ref.current) ref.current.value = ''; }} className="text-muted hover:text-fg" aria-label={`Remove ${label}`}><X className="size-3.5" /></button>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-[12px] text-muted hover:border-accent/60 hover:text-fg">
          {icon}<span>{hint}</span>
        </button>
      )}
    </div>
  );
}

export function CreatePage() {
  const recipes = useRecipes();
  const voices = useVoices();
  const providers = useProviders();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const nav = useNavigate();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'topic' | 'script'>('script');
  const [topic, setTopic] = useState('');
  const [script, setScript] = useState('');
  const [voiceover, setVoiceover] = useState<File | null>(null);
  const [music, setMusic] = useState<File | null>(null);
  const [recipeId, setRecipeId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [videoModel, setVideoModel] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [budget, setBudget] = useState<number | ''>('');
  const [autopilot, setAutopilot] = useState(true);
  const [quality, setQuality] = useState<'final' | 'hd'>('hd');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipe = recipes.data?.find((r) => r.id === recipeId);
  useEffect(() => { if (!recipeId && recipes.data?.length) setRecipeId(recipes.data[0].id); }, [recipes.data, recipeId]);
  useEffect(() => { if (budget === '' && settings.data) setBudget(settings.data.defaultBudgetUsd); }, [settings.data, budget]);

  const usable = (providers.data ?? []).filter((p) => p.implemented && p.configured);
  const modelOpts = (cap: 'image' | 'video') => usable.flatMap((p) => p.models.filter((m) => m.capability === cap).map((m) => ({ value: `${p.id}::${m.id}`, label: `${p.transport === 'mock' ? 'Mock (simulated)' : p.displayName} · ${m.label.replace(/^Mock /, '')}`, real: p.transport !== 'mock', priced: m.unitCostUsd != null })));
  const videoOpts = useMemo(() => modelOpts('video'), [providers.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const imageOpts = useMemo(() => modelOpts('image'), [providers.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const realVoices = (voices.data ?? []).filter((v) => v.provider !== 'mock');
  // Prefer real, priced providers by default.
  useEffect(() => { if (!videoModel && videoOpts.length) setVideoModel((videoOpts.find((o) => o.real && o.priced) ?? videoOpts[0]).value); }, [videoOpts, videoModel]);
  useEffect(() => { if (!imageModel && imageOpts.length) setImageModel((imageOpts.find((o) => o.real && o.priced) ?? imageOpts[0]).value); }, [imageOpts, imageModel]);
  useEffect(() => { if (!voiceId && voices.data?.length) setVoiceId((realVoices[0] ?? voices.data.find((v) => v.id === recipe?.config.voiceId) ?? voices.data[0]).id); }, [voices.data, recipe, voiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const simulated = [
    !voiceover && !realVoices.some((v) => v.id === voiceId) && 'voice',
    !videoOpts.find((o) => o.value === videoModel)?.real && 'video',
    !imageOpts.find((o) => o.value === imageModel)?.real && 'images',
  ].filter(Boolean) as string[];
  const ref = (v: string) => { const [provider, model] = v.split('::'); return provider && model ? { provider, model } : undefined; };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setBusy('Creating project');
      const p = await api.post<Project>('/projects', {
        title: title || (mode === 'topic' ? topic.slice(0, 80) : script.split(/[.!?\n]/)[0].slice(0, 80) || 'Untitled'),
        inputMode: mode, topic, sourceScript: mode === 'script' ? script : '', recipeId, budgetUsd: budget === '' ? undefined : budget,
        voiceId: voiceId || undefined, videoModel: ref(videoModel), imageModel: ref(imageModel),
      });
      if (voiceover) { setBusy('Uploading voiceover'); await api.upload(`/projects/${p.id}/voiceover`, voiceover); }
      if (music) { setBusy('Uploading music'); await api.upload(`/projects/${p.id}/music/upload`, music); }
      if (autopilot) { setBusy('Starting Autopilot'); await api.post(`/projects/${p.id}/autopilot`, { preset: quality }); toast('ok', 'Autopilot started', 'You can leave this page — production continues in the background.'); nav(`/projects/${p.id}/storyboard`); }
      else { await api.post(`/projects/${p.id}/script/generate`, {}); nav(`/projects/${p.id}/script`); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] p-8">
      <PageHeader title="Create a video" subtitle="Script only, or script + your voiceover + your music. Autopilot takes it to an upload-ready MP4." />
      <form onSubmit={submit} className="grid grid-cols-[1fr_380px] gap-6">
        <div className="space-y-5">
          <Panel title="What do you have?">
            <div className="space-y-4">
              <Segmented value={mode} onChange={setMode} options={[{ value: 'script', label: <span className="flex items-center gap-1.5"><FileText className="size-3.5" />My script</span> }, { value: 'topic', label: <span className="flex items-center gap-1.5"><Lightbulb className="size-3.5" />Just a topic</span> }]} />
              <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the first line" maxLength={140} /></Field>
              {mode === 'topic' ? (
                <Field label="Topic" hint="The AI Director writes the script from the recipe's structure, tone and target length.">
                  <textarea className="input min-h-[110px]" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is the video about?" maxLength={1000} />
                </Field>
              ) : (
                <Field label="Script" hint={`${words} words · used verbatim as narration. Separate sections with a blank line.`}>
                  <textarea className="input min-h-[240px]" value={script} onChange={(e) => setScript(e.target.value)} placeholder="Paste your narration script…" maxLength={20000} />
                </Field>
              )}
              {mode === 'script' && (
                <div className="grid grid-cols-2 gap-3">
                  <FilePick label="Voiceover (optional)" hint="Upload your recorded voiceover — WAV, MP3, M4A…" file={voiceover} onFile={setVoiceover} icon={<FileAudio className="size-4" />} accept=".wav,.mp3,.m4a,.aac,.flac,.ogg" />
                  <FilePick label="Music (optional)" hint="Upload a licensed music track" file={music} onFile={setMusic} icon={<Music2 className="size-4" />} accept=".wav,.mp3,.m4a,.aac,.flac,.ogg" />
                </div>
              )}
              {mode === 'script' && voiceover && <p className="text-[12px] text-muted">Your voiceover becomes the master timeline: the script is aligned to it word by word (exactly with ElevenLabs transcription, otherwise from speech pauses), and scenes and captions follow it.</p>}
            </div>
          </Panel>
          {error && <ErrorNote onDismiss={() => setError(null)}>{error}</ErrorNote>}
        </div>

        <div className="space-y-5">
          <Panel title="Channel Recipe" bodyClassName="p-2">
            {recipes.isLoading ? <Spinner /> : (
              <div className="space-y-1">
                {recipes.data?.map((r) => (
                  <button type="button" key={r.id} onClick={() => setRecipeId(r.id)} className={clsx('w-full rounded-lg border px-3 py-2 text-left transition-colors', recipeId === r.id ? 'border-accent/60 bg-accent/8' : 'border-transparent hover:bg-raised')}>
                    <div className="flex items-center justify-between"><span className="font-medium">{r.name}</span><span className="text-[11px] text-muted">{r.config.aspectRatio} · {r.config.targetDurationSec}s</span></div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="Voice & visuals">
            <div className="space-y-3">
              {!voiceover && (
                <Field label="Narration voice">
                  <select className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
                    {voices.data?.map((v) => <option key={v.id} value={v.id}>{v.provider === 'mock' ? `Simulated · ${v.label}` : `${v.providerName} · ${v.label}`}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Video model"><select className="input" value={videoModel} onChange={(e) => setVideoModel(e.target.value)}>{videoOpts.map((o) => <option key={o.value} value={o.value}>{o.label}{o.real && !o.priced ? ' (set price)' : ''}</option>)}</select></Field>
              <Field label="Image model"><select className="input" value={imageModel} onChange={(e) => setImageModel(e.target.value)}>{imageOpts.map((o) => <option key={o.value} value={o.value}>{o.label}{o.real && !o.priced ? ' (set price)' : ''}</option>)}</select></Field>
              {simulated.length > 0 && (
                <div className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-[12px] text-warn">
                  Simulated {simulated.join(', ')} — fine for a test run, but the result won't be ready to upload. <Link to="/providers" className="underline">Connect providers</Link>.
                </div>
              )}
            </div>
          </Panel>
          <Panel title="Production">
            <div className="space-y-3">
              <Field label="Budget (USD)" hint="Generation is refused beyond this."><input type="number" min={0} step={0.5} className="input" value={budget} onChange={(e) => setBudget(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
              <Toggle checked={autopilot} onChange={setAutopilot} label={<span className="flex items-center gap-1.5">Autopilot: produce the whole video <Badge tone="accent">recommended</Badge></span>} />
              {autopilot && <Segmented size="sm" value={quality} onChange={setQuality} options={[{ value: 'hd', label: 'HD 1080p' }, { value: 'final', label: '720p' }]} />}
            </div>
          </Panel>
          <Button type="submit" variant="primary" className="h-10 w-full" loading={!!busy} icon={autopilot ? <Rocket className="size-4" /> : <Wand2 className="size-4" />} disabled={!recipeId || (mode === 'topic' ? topic.trim().length < 3 : words < 10)}>
            {busy ?? (autopilot ? 'Produce video' : 'Create project')}
          </Button>
        </div>
      </form>
    </div>
  );
}
