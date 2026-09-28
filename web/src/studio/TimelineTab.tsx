import clsx from 'clsx';
import { Captions, Film, Layers, Music2, Pause, Play, SkipBack, Waves } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetThumb, aspectClass } from '../components/common';
import { Badge, Button, Empty } from '../components/ui';
import { assetUrl, thumbUrl } from '../lib/api';
import { timecode } from '../lib/format';
import type { ProjectState } from '../lib/types';
import type { ProjectActions } from './Studio';

/**
 * Composite preview player. The narration <audio> element is the master clock;
 * visuals, captions and music follow it — mirroring how the renderer works.
 */
function PreviewPlayer({ state, time, setTime, playing, setPlaying, audioRef }: {
  state: ProjectState; time: number; setTime: (t: number) => void; playing: boolean; setPlaying: (v: boolean) => void; audioRef: React.RefObject<HTMLAudioElement | null>;
}) {
  const p = state.project;
  const music = useRef<HTMLAudioElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scenes = state.scenes;
  const cur = scenes.find((s) => time >= s.startSec && time < s.endSec) ?? scenes[scenes.length - 1];
  const asset = cur ? cur.candidates.find((c) => c.id === cur.selectedAssetId) ?? null : null;
  const caption = p.captions.enabled ? p.captions.cues.find((c) => time >= c.start && time < c.end)?.text : undefined;
  const musicAsset = p.music.enabled && p.musicAssetId ? p.musicAssetId : null;

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused) {
        setTime(a.currentTime);
        const m = music.current;
        if (m && Math.abs(m.currentTime - a.currentTime) > 0.3) m.currentTime = a.currentTime;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioRef, setTime]);

  // Keep the scene's video clip in sync with the master clock.
  useEffect(() => {
    const v = video.current;
    if (!v || !cur || asset?.mediaType !== 'video') return;
    const local = time - cur.startSec;
    const d = v.duration || asset.durationSec || 1;
    const want = local % d;
    if (Math.abs(v.currentTime - want) > 0.35) v.currentTime = want;
    if (playing && v.paused) void v.play().catch(() => {});
    if (!playing && !v.paused) v.pause();
  }, [time, playing, cur, asset]);

  useEffect(() => {
    const m = music.current;
    if (!m) return;
    m.volume = p.music.volume;
    if (playing) void m.play().catch(() => {}); else m.pause();
  }, [playing, p.music.volume]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { if (a.ended) a.currentTime = 0; void a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); } else { a.pause(); }
  };

  return (
    <div>
      <div className={clsx('relative mx-auto overflow-hidden rounded-lg border border-line bg-black', aspectClass(p.recipeSnapshot.aspectRatio), p.recipeSnapshot.aspectRatio === '9:16' ? 'h-[46vh]' : 'max-h-[46vh] w-full max-w-[820px]')}>
        {asset?.mediaType === 'image' && (
          <img key={cur.id + String(playing)} src={assetUrl(asset.id)} alt="" className={clsx('size-full object-cover', playing && 'kenburns')}
            style={{ animationDuration: `${cur.endSec - cur.startSec}s`, animationDelay: `-${Math.max(0, time - cur.startSec)}s` }} />
        )}
        {asset?.mediaType === 'video' && <video ref={video} key={asset.id} src={assetUrl(asset.id)} poster={thumbUrl(asset.id)} muted playsInline loop className="size-full object-cover" />}
        {!asset && <div className="grid size-full place-items-center text-faint">No visual for this scene</div>}
        {caption && (
          <div className={clsx('absolute inset-x-0 px-8 text-center', p.captions.position === 'center' ? 'top-1/2 -translate-y-1/2' : 'bottom-[8%]')}>
            <span className="rounded bg-black/50 px-2 py-0.5 text-[17px] font-semibold text-white [text-shadow:0_2px_4px_#000]">{caption}</span>
          </div>
        )}
        {cur && <div className="absolute top-2 left-2"><Badge>Scene {cur.index}</Badge></div>}
      </div>
      {p.narrationAssetId && <audio ref={audioRef} src={assetUrl(p.narrationAssetId)} preload="auto" onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} onEnded={() => setPlaying(false)} />}
      {musicAsset && <audio ref={music} src={assetUrl(musicAsset)} preload="auto" loop />}
      <div className="mx-auto mt-3 flex max-w-[820px] items-center gap-2">
        <Button size="sm" variant="ghost" aria-label="Back to start" onClick={() => { if (audioRef.current) audioRef.current.currentTime = 0; setTime(0); }} icon={<SkipBack className="size-3.5" />} />
        <Button size="sm" variant="primary" onClick={toggle} disabled={!p.narrationAssetId} icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}>{playing ? 'Pause' : 'Play'}</Button>
        <span className="font-mono text-[12px] tabular-nums text-muted">{timecode(time)} / {timecode(p.narrationDurationSec ?? 0)}</span>
        <span className="ml-auto text-[11px] text-faint">Live preview — the final MP4 is produced by the renderer from the assembled timeline.</span>
      </div>
    </div>
  );
}

export function TimelineTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const total = p.narrationDurationSec ?? 0;
  const pxPerSec = 22 * zoom;
  const width = Math.max(600, total * pxPerSec);
  const seek = useCallback((t: number) => { const a = audioRef.current; if (a) a.currentTime = t; setTime(t); }, []);
  const ticks = useMemo(() => { const step = zoom >= 2 ? 1 : zoom >= 1 ? 5 : 10; return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step); }, [total, zoom]);
  const canAssemble = ['assets_ready', 'assembled', 'qa_passed', 'qa_failed', 'rendered'].includes(p.status);

  if (!total || !state.scenes.length) {
    return <div className="p-8"><Empty icon={<Layers className="size-6" />} title="Nothing on the timeline yet">Generate narration and split it into scenes. The narration is the master track every other track aligns to.</Empty></div>;
  }

  const trackLabel = (icon: React.ReactNode, label: string) => <div className="flex h-full items-center gap-1.5 border-r border-line bg-panel px-3 text-[11px] font-medium text-muted">{icon}{label}</div>;
  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, Math.min(total, (e.clientX - rect.left) / pxPerSec)));
  };

  return (
    <div className="space-y-4 p-5">
      <PreviewPlayer state={state} time={time} setTime={setTime} playing={playing} setPlaying={setPlaying} audioRef={audioRef} />

      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2.5">
        {p.timeline
          ? p.timelineCurrent ? <Badge tone="ok">Assembled · up to date</Badge> : <Badge tone="warn">Assembled timeline is out of date</Badge>
          : <Badge>Not assembled</Badge>}
        <span className="text-[12px] text-muted">{state.scenes.length} clips · {total.toFixed(2)}s · captions {p.captions.cues.length ? `${p.captions.cues.length} cues` : 'none'} · music {p.musicAssetId && p.music.enabled ? 'on' : 'off'}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted">Zoom</span>
          <input type="range" min={0.5} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28" />
          <Button size="sm" variant={p.status === 'assets_ready' ? 'primary' : 'secondary'} icon={<Layers className="size-3.5" />} disabled={!canAssemble} loading={actions.assemble.isPending}
            title={canAssemble ? undefined : 'Every scene needs a visual first'} onClick={() => actions.assemble.mutate()}>{p.timeline ? 'Re-assemble' : 'Assemble timeline'}</Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel-2">
        <div className="grid grid-cols-[110px_1fr]">
          <div className="grid grid-rows-[24px_78px_34px_30px_30px] border-b border-line">
            <div className="border-r border-b border-line bg-panel" />
            <div className="border-b border-line">{trackLabel(<Film className="size-3.5" />, 'Video')}</div>
            <div className="border-b border-line">{trackLabel(<Waves className="size-3.5" />, 'Narration')}</div>
            <div className="border-b border-line">{trackLabel(<Captions className="size-3.5" />, 'Captions')}</div>
            <div>{trackLabel(<Music2 className="size-3.5" />, 'Music')}</div>
          </div>
          <div className="overflow-x-auto">
            <div className="relative grid grid-rows-[24px_78px_34px_30px_30px] border-b border-line" style={{ width }} onClick={onTrackClick}>
              <div className="relative border-b border-line bg-panel">
                {ticks.map((t) => <span key={t} className="absolute top-0 h-full border-l border-line-strong pl-1 font-mono text-[9px] leading-6 text-faint" style={{ left: t * pxPerSec }}>{timecode(t, false)}</span>)}
              </div>
              <div className="relative border-b border-line">
                {state.scenes.map((s) => {
                  const a = s.candidates.find((c) => c.id === s.selectedAssetId);
                  return (
                    <div key={s.id} className={clsx('absolute top-1.5 bottom-1.5 overflow-hidden rounded-md border', time >= s.startSec && time < s.endSec ? 'border-accent' : 'border-line-strong', !a && 'border-dashed border-bad/50 bg-bad/5')}
                      style={{ left: s.startSec * pxPerSec + 1, width: Math.max(4, (s.endSec - s.startSec) * pxPerSec - 2) }} title={`Scene ${s.index} · ${(s.endSec - s.startSec).toFixed(1)}s`}>
                      {a && <AssetThumb asset={a} className="absolute inset-0 opacity-80" playOnHover={false} />}
                      <span className="absolute top-1 left-1 rounded bg-black/65 px-1 text-[10px] font-semibold text-white">{s.index}</span>
                      {a?.mediaType === 'video' && <Film className="absolute right-1 bottom-1 size-3 text-white drop-shadow" />}
                    </div>
                  );
                })}
              </div>
              <div className="relative border-b border-line">
                <div className="absolute inset-y-2 left-0 flex items-center gap-px overflow-hidden rounded bg-info/10" style={{ width: total * pxPerSec }}>
                  {(p.narrationWords ?? []).map((w, i) => (
                    <span key={i} className="absolute bottom-0 w-[2px] rounded-t bg-info/60" style={{ left: w.start * pxPerSec, height: `${30 + ((i * 37) % 60)}%`, width: Math.max(2, (w.end - w.start) * pxPerSec - 1) }} />
                  ))}
                </div>
              </div>
              <div className="relative border-b border-line">
                {p.captions.cues.map((c, i) => (
                  <div key={i} className="absolute top-1 bottom-1 truncate rounded bg-warn/12 px-1 text-[10px] leading-5 text-warn" style={{ left: c.start * pxPerSec, width: Math.max(3, (c.end - c.start) * pxPerSec - 1) }} title={c.text}>{c.text}</div>
                ))}
              </div>
              <div className="relative">
                {p.musicAssetId && p.music.enabled && <div className="absolute inset-y-1.5 left-0 rounded bg-ok/12 px-2 text-[10px] leading-[18px] text-ok" style={{ width: total * pxPerSec }}>{p.music.mood} · {Math.round(p.music.volume * 100)}%{p.music.duck ? ' · ducked under narration' : ''}</div>}
              </div>
              <div className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{ left: time * pxPerSec }}><div className="absolute -top-0 -left-1 size-2 rotate-45 bg-accent" /></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
