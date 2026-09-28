import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AssetThumb } from '../components/common';
import { useToast } from '../components/toast';
import { Badge, Button, Empty } from '../components/ui';
import { api } from '../lib/api';
import { ago, bytes, secs } from '../lib/format';
import type { Asset, ProjectState } from '../lib/types';
import { AssetPreview } from '../pages/Assets';

const GROUPS: { label: string; match: (a: Asset) => boolean }[] = [
  { label: 'Renders & packages', match: (a) => a.kind === 'render' || a.kind === 'package' },
  { label: 'Scene visuals', match: (a) => a.mediaType === 'image' || a.mediaType === 'video' },
  { label: 'Audio', match: (a) => a.mediaType === 'audio' },
];

export function AssetsTab({ state }: { state: ProjectState }) {
  const p = state.project;
  const [preview, setPreview] = useState<Asset | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const inUse = new Set([...state.scenes.map((s) => s.selectedAssetId), p.narrationAssetId, p.musicAssetId, p.finalRenderAssetId, p.packageAssetId].filter(Boolean));
  const sceneIndex = new Map(state.scenes.map((s) => [s.id, s.index]));
  async function upload(f: File) {
    setUploading(true);
    try {
      await api.upload(`/assets/upload?projectId=${p.id}`, f);
      toast('ok', 'Uploaded');
      await qc.invalidateQueries({ queryKey: ['project', p.id] });
    } catch (e) {
      toast('error', 'Upload rejected', (e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }
  const seen = new Set<string>();
  return (
    <div className="space-y-6 p-5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted">{state.assets.length} files in this project. Every generation is kept, so you can return to an earlier variant.</p>
        <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.wav,.mp3" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => input.current?.click()}>Upload to project</Button>
      </div>
      {state.assets.length === 0 && <Empty title="No assets yet">Narration, scene visuals, music and renders appear here.</Empty>}
      {GROUPS.map((g) => {
        const items = state.assets.filter((a) => !seen.has(a.id) && g.match(a));
        items.forEach((a) => seen.add(a.id));
        if (!items.length) return null;
        return (
          <section key={g.label}>
            <h3 className="mb-2 text-[12px] font-semibold text-muted uppercase">{g.label} <span className="text-faint">({items.length})</span></h3>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
              {items.map((a) => (
                <button key={a.id} onClick={() => setPreview(a)} className="overflow-hidden rounded-lg border border-line bg-panel text-left hover:border-line-strong">
                  <AssetThumb asset={a} className="aspect-video" />
                  <div className="p-2">
                    <div className="truncate text-[12px] font-medium">{a.label || a.kind}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {inUse.has(a.id) && <Badge tone="ok">in use</Badge>}
                      {a.sceneId && sceneIndex.has(a.sceneId) && <Badge>scene {sceneIndex.get(a.sceneId)}</Badge>}
                      <Badge>{a.source}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-faint">{a.durationSec != null ? `${secs(a.durationSec)} · ` : ''}{bytes(a.bytes)} · {ago(a.createdAt)}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <AssetPreview asset={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
