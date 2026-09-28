import clsx from 'clsx';
import { FileArchive, Music2, ImageOff } from 'lucide-react';
import { assetUrl, thumbUrl } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';
import type { Asset, ProjectStatus } from '../lib/types';
import { Badge, type Tone } from './ui';

const BUSY = ['scripting', 'narrating', 'segmenting', 'planning', 'producing', 'qa_running', 'rendering'];

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const tone: Tone = status === 'rendered' ? 'ok' : status === 'qa_failed' ? 'bad' : BUSY.includes(status) ? 'accent' : status === 'draft' ? 'neutral' : 'info';
  return <Badge tone={tone} pulse={BUSY.includes(status)}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function SceneStatusBadge({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    pending: ['neutral', 'Needs brief'], planned: ['info', 'Planned'], queued: ['accent', 'Queued'], generating: ['accent', 'Generating'],
    generated: ['ok', 'Generated'], failed: ['bad', 'Failed'],
  };
  const [tone, label] = map[status] ?? ['neutral', status];
  return <Badge tone={tone} pulse={status === 'generating' || status === 'queued'}>{label}</Badge>;
}

export function QualityBadge({ status, notes }: { status: string; notes?: string | null }) {
  if (status === 'unchecked') return <Badge tone="neutral">QA —</Badge>;
  const tone: Tone = status === 'pass' ? 'ok' : status === 'warn' ? 'warn' : 'bad';
  return <span title={notes ?? undefined}><Badge tone={tone}>QA {status}</Badge></span>;
}

export function JobStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' ? 'accent' : status === 'cancelled' ? 'neutral' : 'info';
  return <Badge tone={tone} pulse={status === 'running'}>{status}</Badge>;
}

export function AssetThumb({ asset, className, playOnHover = true, fit = 'cover' }: { asset: Pick<Asset, 'id' | 'mediaType'> | null | undefined; className?: string; playOnHover?: boolean; fit?: 'cover' | 'contain' }) {
  const base = clsx('size-full bg-black', fit === 'cover' ? 'object-cover' : 'object-contain');
  if (!asset) return <div className={clsx('grid place-items-center bg-bg text-faint', className)}><ImageOff className="size-5" /></div>;
  return (
    <div className={clsx('overflow-hidden bg-black', className)}>
      {asset.mediaType === 'image' && <img src={assetUrl(asset.id)} alt="" loading="lazy" className={base} />}
      {asset.mediaType === 'video' && !playOnHover && <img src={thumbUrl(asset.id)} alt="" loading="lazy" className={base} />}
      {asset.mediaType === 'video' && playOnHover && (
        <video src={assetUrl(asset.id)} poster={thumbUrl(asset.id)} muted loop playsInline preload="none" className={base}
          onMouseEnter={(e) => { if (playOnHover) void e.currentTarget.play().catch(() => {}); }}
          onMouseLeave={(e) => { e.currentTarget.pause(); }} />
      )}
      {asset.mediaType === 'audio' && <div className="grid size-full place-items-center text-muted"><Music2 className="size-5" /></div>}
      {asset.mediaType === 'archive' && <div className="grid size-full place-items-center text-muted"><FileArchive className="size-5" /></div>}
    </div>
  );
}

export function aspectClass(aspect: string) {
  return aspect === '9:16' ? 'aspect-[9/16]' : aspect === '1:1' ? 'aspect-square' : 'aspect-video';
}
