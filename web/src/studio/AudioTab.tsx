import { Captions, FileAudio, Mic, Music2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/toast';
import type { Asset } from '../lib/types';
import { Badge, Button, Field, Panel, Segmented, Toggle } from '../components/ui';
import { api, assetUrl } from '../lib/api';
import { timecode } from '../lib/format';
import { useAction, useVoices } from '../lib/hooks';
import type { ProjectState } from '../lib/types';
import type { ProjectActions } from './Studio';

export function AudioTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const voices = useVoices();
  const patch = useAction((body: Record<string, unknown>) => api.patch(`/projects/${p.id}`, body), { projectId: p.id });
  const [mood, setMood] = useState(p.music.mood);
  const [volume, setVolume] = useState(p.music.volume);
  useEffect(() => { setMood(p.music.mood); setVolume(p.music.volume); }, [p.music.mood, p.music.volume]);
  const narrationJob = state.jobs.find((j) => j.type === 'narration.generate' && (j.status === 'running' || j.status === 'queued'));
  const musicJob = state.jobs.find((j) => j.type === 'music.generate' && (j.status === 'running' || j.status === 'queued'));
  const music = state.assets.find((a) => a.id === p.musicAssetId);
  const voiceover = state.assets.find((a) => a.id === p.voiceoverAssetId);
  const qc = useQueryClient();
  const { toast } = useToast();
  const voRef = useRef<HTMLInputElement>(null);
  const muRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const library = useQuery({ queryKey: ['assets', 'audio', p.id], queryFn: () => api.get<Asset[]>(`/assets?mediaType=audio&projectId=${p.id}`) });
  const tracks = (library.data ?? []).filter((a) => a.kind === 'music' || (a.kind === 'upload' && a.mediaType === 'audio'));
  const removeVo = useAction(() => api.del(`/projects/${p.id}/voiceover`), { projectId: p.id, success: 'Voiceover removed — narration will use the selected voice' });
  const selectMusic = useAction((assetId: string) => api.post(`/projects/${p.id}/music/select`, { assetId }), { projectId: p.id, success: 'Music track selected' });
  async function up(kind: 'voiceover' | 'music', f: File) {
    setUploading(kind);
    try {
      await api.upload(kind === 'voiceover' ? `/projects/${p.id}/voiceover` : `/projects/${p.id}/music/upload`, f);
      toast('ok', kind === 'voiceover' ? 'Voiceover uploaded' : 'Music uploaded', kind === 'voiceover' ? 'Click "Align voiceover" to rebuild the timing from it.' : undefined);
      await qc.invalidateQueries({ queryKey: ['project', p.id] });
      await qc.invalidateQueries({ queryKey: ['assets'] });
    } catch (e) { toast('error', 'Upload rejected', (e as Error).message); } finally { setUploading(null); }
  }
  const timingLabel: Record<string, string> = { tts_timestamps: 'Exact TTS timestamps', transcription: 'Aligned by transcription', pause_alignment: 'Aligned from speech pauses', simulated: 'Simulated voice' };

  return (
    <div className="grid grid-cols-2 gap-5 p-5">
      <Panel title={<span className="flex items-center gap-2"><Mic className="size-4" />Narration · master timeline</span>} className="col-span-2">
        <div className="grid grid-cols-[280px_1fr] gap-6">
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-bg p-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-medium"><FileAudio className="size-3.5" />Your voiceover</div>
              <input ref={voRef} type="file" hidden accept=".wav,.mp3,.m4a,.aac,.flac,.ogg" onChange={(e) => { const f = e.target.files?.[0]; if (f) void up('voiceover', f); e.target.value = ''; }} />
              {voiceover ? (
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="flex-1 truncate">{voiceover.label}</span>
                  <Button size="xs" loading={uploading === 'voiceover'} onClick={() => voRef.current?.click()}>Replace</Button>
                  <Button size="xs" variant="ghost" aria-label="Remove voiceover" icon={<Trash2 className="size-3" />} onClick={() => removeVo.mutate()} />
                </div>
              ) : (
                <Button size="sm" className="w-full" icon={<Upload className="size-3.5" />} loading={uploading === 'voiceover'} onClick={() => voRef.current?.click()}>Upload voiceover</Button>
              )}
              <p className="mt-2 text-[11px] text-faint">{voiceover ? 'Narration = this recording, aligned to your script.' : 'Or leave empty and use a voice below.'}</p>
            </div>
            <Field label="Voice">
              <select className="input" value={p.voiceId} disabled={p.busy} onChange={(e) => patch.mutate({ voiceId: e.target.value })}>
                {voices.data?.map((v) => <option key={v.id} value={v.id}>{v.label} — {v.description}</option>)}
              </select>
            </Field>
            <Button className="w-full" variant={p.narrationAssetId ? 'secondary' : 'primary'} icon={<RefreshCw className="size-3.5" />}
              disabled={!p.script || p.busy || p.status === 'producing'} loading={actions.narration.isPending || !!narrationJob} onClick={() => actions.narration.mutate()}>
              {narrationJob ? `Working… ${Math.round(narrationJob.progress * 100)}%` : p.voiceoverAssetId ? (p.narrationAssetId === p.voiceoverAssetId ? 'Re-align voiceover' : 'Align voiceover') : p.narrationAssetId ? 'Regenerate narration' : 'Generate narration'}
            </Button>
            <p className="text-[11px] text-faint">Duration is measured from the rendered audio (ffprobe), not estimated. Regenerating replaces the scenes built on the old timing.</p>
          </div>
          <div>
            {p.narrationAssetId ? (
              <>
                <audio src={assetUrl(p.narrationAssetId)} controls className="w-full" />
                <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
                  <Badge tone="info">Measured {p.narrationDurationSec?.toFixed(3)}s</Badge>
                  <Badge>{p.narrationWords?.length ?? 0} timed words</Badge>
                  {p.narrationTimingSource && <Badge tone={p.narrationTimingSource === 'simulated' ? 'warn' : 'ok'}>{timingLabel[p.narrationTimingSource] ?? p.narrationTimingSource}</Badge>}
                  {!p.voiceoverAssetId && <Badge>{p.voiceId}</Badge>}
                </div>
                <div className="mt-3 max-h-28 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[10.5px] leading-5 text-muted">
                  {(p.narrationWords ?? []).slice(0, 120).map((w, i) => <span key={i} className="mr-2 whitespace-nowrap"><span className="text-faint">{timecode(w.start)}</span> {w.word}</span>)}
                  {(p.narrationWords?.length ?? 0) > 120 && <span className="text-faint">…</span>}
                </div>
              </>
            ) : <div className="grid h-full place-items-center rounded-lg border border-dashed border-line p-8 text-muted">No narration yet.</div>}
          </div>
        </div>
      </Panel>

      <Panel title={<span className="flex items-center gap-2"><Music2 className="size-4" />Music</span>}
        actions={<Toggle checked={p.music.enabled} onChange={(v) => patch.mutate({ music: { enabled: v } })} label="Enabled" />}>
        <div className="space-y-3">
          <Field label="Mood"><input className="input" value={mood} onChange={(e) => setMood(e.target.value)} onBlur={() => mood !== p.music.mood && patch.mutate({ music: { mood } })} /></Field>
          <Field label={`Volume ${Math.round(volume * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={volume} className="w-full" onChange={(e) => setVolume(Number(e.target.value))} onMouseUp={() => patch.mutate({ music: { volume } })} onKeyUp={() => patch.mutate({ music: { volume } })} /></Field>
          <Toggle checked={p.music.duck} onChange={(v) => patch.mutate({ music: { duck: v } })} label="Duck music under narration (sidechain)" />
          {music && <audio src={assetUrl(music.id)} controls className="w-full" />}
          <input ref={muRef} type="file" hidden accept=".wav,.mp3,.m4a,.aac,.flac,.ogg" onChange={(e) => { const f = e.target.files?.[0]; if (f) void up('music', f); e.target.value = ''; }} />
          <div className="flex gap-2">
            <Button size="sm" icon={<Upload className="size-3.5" />} loading={uploading === 'music'} onClick={() => muRef.current?.click()}>Upload music</Button>
            {tracks.length > 0 && (
              <select className="input py-1 text-[12px]" value={p.musicAssetId ?? ''} onChange={(e) => e.target.value && selectMusic.mutate(e.target.value)}>
                <option value="">Choose from your tracks…</option>
                {tracks.map((t) => <option key={t.id} value={t.id}>{t.label || t.kind}{t.source === 'generated' ? ' (generated)' : ''}</option>)}
              </select>
            )}
          </div>
          <Button size="sm" icon={<Music2 className="size-3.5" />} variant="ghost" disabled={!p.narrationDurationSec} loading={actions.music.isPending || !!musicJob} onClick={() => actions.music.mutate()}>
            {musicJob ? `Generating… ${Math.round(musicJob.progress * 100)}%` : 'Generate music (provider)'}
          </Button>
          {!p.narrationDurationSec && <p className="text-[11px] text-faint">Music length follows the narration — generate narration first.</p>}
        </div>
      </Panel>

      <Panel title={<span className="flex items-center gap-2"><Captions className="size-4" />Captions</span>}
        actions={<Toggle checked={p.captions.enabled} onChange={(v) => patch.mutate({ captions: { enabled: v } })} label="Enabled" />}>
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <Segmented value={p.captions.position} onChange={(v) => patch.mutate({ captions: { position: v } })} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'center', label: 'Center' }]} />
            <label className="flex items-center gap-2 text-[12px]">Max chars <input type="number" className="input w-20" defaultValue={p.captions.maxChars} min={12} max={80} onBlur={(e) => Number(e.target.value) !== p.captions.maxChars && patch.mutate({ captions: { maxChars: Number(e.target.value) } })} /></label>
          </div>
          <Button icon={<Captions className="size-3.5" />} variant={p.captions.cues.length ? 'secondary' : 'primary'} disabled={!p.narrationWords?.length} loading={actions.captions.isPending} onClick={() => actions.captions.mutate()}>
            {p.captions.cues.length ? 'Rebuild captions' : 'Generate captions'}
          </Button>
          <p className="text-[11px] text-faint">Built deterministically from narration word timings.</p>
          {p.captions.cues.length > 0 && (
            <div className="max-h-52 overflow-auto rounded-lg border border-line">
              {p.captions.cues.map((c, i) => (
                <div key={i} className="flex gap-3 border-b border-line px-3 py-1.5 text-[12px] last:border-0"><span className="font-mono text-[10.5px] text-faint">{timecode(c.start)}–{timecode(c.end)}</span><span>{c.text}</span></div>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
