import { Captions, Mic, Music2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
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

  return (
    <div className="grid grid-cols-2 gap-5 p-5">
      <Panel title={<span className="flex items-center gap-2"><Mic className="size-4" />Narration · master timeline</span>} className="col-span-2">
        <div className="grid grid-cols-[280px_1fr] gap-6">
          <div className="space-y-3">
            <Field label="Voice">
              <select className="input" value={p.voiceId} disabled={p.busy} onChange={(e) => patch.mutate({ voiceId: e.target.value })}>
                {voices.data?.map((v) => <option key={v.id} value={v.id}>{v.label} — {v.description}</option>)}
              </select>
            </Field>
            <Button className="w-full" variant={p.narrationAssetId ? 'secondary' : 'primary'} icon={<RefreshCw className="size-3.5" />}
              disabled={!p.script || p.busy || p.status === 'producing'} loading={actions.narration.isPending || !!narrationJob} onClick={() => actions.narration.mutate()}>
              {narrationJob ? `Generating… ${Math.round(narrationJob.progress * 100)}%` : p.narrationAssetId ? 'Regenerate narration' : 'Generate narration'}
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
                  <Badge>{p.voiceId}</Badge>
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
          <Button icon={<Music2 className="size-3.5" />} variant={p.musicAssetId ? 'secondary' : 'primary'} disabled={!p.narrationDurationSec} loading={actions.music.isPending || !!musicJob} onClick={() => actions.music.mutate()}>
            {musicJob ? `Generating… ${Math.round(musicJob.progress * 100)}%` : p.musicAssetId ? 'Regenerate music' : 'Generate mock music'}
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
