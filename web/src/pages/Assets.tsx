import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { AssetThumb } from '../components/common';
import { useToast } from '../components/toast';
import { Badge, Button, Empty, Modal, PageHeader, Segmented, Spinner } from '../components/ui';
import { api, assetUrl, downloadUrl, thumbUrl } from '../lib/api';
import { ago, bytes, secs } from '../lib/format';
import type { Asset } from '../lib/types';

export function AssetPreview({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  return (
    <Modal open={!!asset} onClose={onClose} title={asset?.label || asset?.kind} wide
      footer={asset && <a href={downloadUrl(asset.id)}><Button icon={<Download className="size-3.5" />}>Download</Button></a>}>
      {asset && (
        <div className="grid place-items-center rounded-lg bg-black">
          {asset.mediaType === 'image' && <img src={assetUrl(asset.id)} className="max-h-[65vh] object-contain" alt="" />}
          {asset.mediaType === 'video' && <video src={assetUrl(asset.id)} poster={thumbUrl(asset.id)} controls autoPlay className="max-h-[65vh]" />}
          {asset.mediaType === 'audio' && <audio src={assetUrl(asset.id)} controls autoPlay className="m-10 w-full max-w-lg" />}
          {asset.mediaType === 'archive' && <div className="p-10 text-muted">Archive · {bytes(asset.bytes)}</div>}
        </div>
      )}
      {asset && <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-muted"><span>{asset.mime}</span><span>{bytes(asset.bytes)}</span>{asset.width && <span>{asset.width}×{asset.height}</span>}{asset.durationSec != null && <span>{secs(asset.durationSec)}</span>}<span>{asset.source}</span></div>}
    </Modal>
  );
}

export function AssetsPage() {
  const [type, setType] = useState<'all' | 'image' | 'video' | 'audio' | 'archive'>('all');
  const [preview, setPreview] = useState<Asset | null>(null);
  const q = useQuery({ queryKey: ['assets', type], queryFn: () => api.get<Asset[]>(`/assets${type === 'all' ? '' : `?mediaType=${type}`}`) });
  const qc = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  async function upload(f: File) {
    setUploading(true);
    try { await api.upload('/assets/upload', f); toast('ok', 'Uploaded to library'); await qc.invalidateQueries({ queryKey: ['assets'] }); }
    catch (e) { toast('error', 'Upload rejected', (e as Error).message); }
    finally { setUploading(false); if (input.current) input.current.value = ''; }
  }
  return (
    <div className="mx-auto max-w-[1400px] p-8">
      <PageHeader title="Assets" subtitle="Every generated, uploaded and rendered file across projects."
        actions={<>
          <Segmented value={type} onChange={setType} options={[{ value: 'all', label: 'All' }, { value: 'image', label: 'Images' }, { value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio' }, { value: 'archive', label: 'Packages' }]} />
          <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.wav,.mp3" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button variant="primary" loading={uploading} icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>Upload</Button>
        </>} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <Empty title="No assets yet">Generated media appears here as your projects progress.</Empty> : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
          {q.data.map((a) => (
            <button key={a.id} onClick={() => setPreview(a)} className="group overflow-hidden rounded-lg border border-line bg-panel text-left hover:border-line-strong">
              <AssetThumb asset={a} className="aspect-video" />
              <div className="p-2.5">
                <div className="truncate text-[12px] font-medium">{a.label || a.kind}</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                  <Badge>{a.kind}</Badge>
                  <span className="truncate">{a.projectId ? <Link to={`/projects/${a.projectId}/assets`} onClick={(e) => e.stopPropagation()} className="hover:text-fg">{a.projectTitle}</Link> : 'Library'}</span>
                </div>
                <div className="mt-1 text-[11px] text-faint">{ago(a.createdAt)} · {bytes(a.bytes)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      <AssetPreview asset={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
