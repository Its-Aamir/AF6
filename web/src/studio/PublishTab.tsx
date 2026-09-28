import { CheckCircle2, CircleAlert, Download, Film, Package, Play, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Empty, Panel, Progress, Segmented } from '../components/ui';
import { assetUrl, downloadUrl, thumbUrl } from '../lib/api';
import { ago, bytes, secs } from '../lib/format';
import type { ProjectState } from '../lib/types';
import type { ProjectActions } from './Studio';

export function PublishTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const [preset, setPreset] = useState<'hd' | 'final' | 'draft'>('hd');
  const renderJob = state.jobs.find((j) => j.type === 'render.final' && (j.status === 'running' || j.status === 'queued'));
  const lastRenderJob = state.jobs.find((j) => j.type === 'render.final');
  const pkgJob = state.jobs.find((j) => j.type === 'package.export' && (j.status === 'running' || j.status === 'queued'));
  const renders = state.assets.filter((a) => a.kind === 'render');
  const finalAsset = state.assets.find((a) => a.id === p.finalRenderAssetId);
  const pkg = state.assets.find((a) => a.id === p.packageAssetId);
  const canRender = p.status === 'qa_passed' || p.status === 'rendered';
  const stale = !!finalAsset && p.status !== 'rendered' && p.status !== 'rendering';
  return (
    <div className="grid grid-cols-[1fr_360px] gap-5 p-5">
      <Panel title="Final video">
        {finalAsset ? (
          <>
            {stale && <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-warn">The project changed since this render. Re-assemble, run QA and render again to include the changes.</div>}
            <video key={finalAsset.id} src={assetUrl(finalAsset.id)} poster={thumbUrl(finalAsset.id)} controls className="max-h-[60vh] w-full rounded-lg bg-black" />
            <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
              <Badge tone="ok">MP4</Badge><span>{finalAsset.width}×{finalAsset.height}</span><span>{secs(finalAsset.durationSec)}</span><span>{bytes(finalAsset.bytes)}</span><span>{ago(finalAsset.createdAt)}</span>
              <a href={downloadUrl(finalAsset.id)} className="ml-auto"><Button variant="primary" icon={<Download className="size-3.5" />}>Download MP4</Button></a>
            </div>
          </>
        ) : renderJob ? (
          <div className="grid place-items-center gap-3 py-16 text-center">
            <Film className="size-8 text-accent" />
            <div className="font-medium">Rendering… {Math.round(renderJob.progress * 100)}%</div>
            <Progress value={renderJob.progress} className="w-80" />
            <div className="text-[12px] text-muted">{renderJob.progressMessage ?? 'Queued'} · runs in the background, safe to leave this page</div>
          </div>
        ) : (
          <Empty icon={<Film className="size-6" />} title="Not rendered yet">{canRender ? 'QA passed — render the final MP4.' : 'Assemble the timeline and pass QA before rendering.'}</Empty>
        )}
      </Panel>
      <div className="space-y-5">
        {p.renderReport && finalAsset && p.renderReport.assetId === finalAsset.id && (
          <Panel title={<span className="flex items-center gap-2">Ready to upload? {p.renderReport.publishReady ? <Badge tone="ok">Yes</Badge> : <Badge tone="bad">Not yet</Badge>}</span>} bodyClassName="p-0">
            <ul>
              {p.renderReport.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-2.5 border-b border-line px-4 py-2 text-[12px] last:border-0">
                  {c.status === 'pass' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : c.status === 'warn' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-bad" />}
                  <div><div className="font-medium">{c.label}</div><div className="text-muted">{c.message}</div></div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title="Render">
          <div className="space-y-3">
            <Segmented value={preset} onChange={setPreset} options={[{ value: 'hd', label: 'HD 1080p' }, { value: 'final', label: '720p' }, { value: 'draft', label: 'Draft' }]} />
            <Button className="w-full" variant="primary" icon={<Play className="size-3.5" />} disabled={!canRender || p.busy} loading={actions.render.isPending || !!renderJob} onClick={() => actions.render.mutate(preset)}>
              {renderJob ? `Rendering ${Math.round(renderJob.progress * 100)}%` : finalAsset ? 'Render again' : 'Render MP4'}
            </Button>
            {renderJob && <Progress value={renderJob.progress} />}
            {!canRender && <p className="text-[11px] text-faint">Rendering requires a passing QA report on the current timeline.</p>}
            {lastRenderJob?.status === 'failed' && <p className="text-[12px] text-bad">Last render failed: {lastRenderJob.error}</p>}
          </div>
        </Panel>
        <Panel title="Project package">
          <p className="mb-3 text-[12px] text-muted">Zip with the final MP4, narration, music, scene visuals, script, SRT captions and a machine-readable <code>project.json</code>.</p>
          <div className="flex gap-2">
            <Button icon={<Package className="size-3.5" />} loading={actions.pkg.isPending || !!pkgJob} disabled={!p.script} onClick={() => actions.pkg.mutate()}>{pkg ? 'Rebuild package' : 'Build package'}</Button>
            {pkg && <a href={downloadUrl(pkg.id)}><Button variant="primary" icon={<Download className="size-3.5" />}>Download ({bytes(pkg.bytes)})</Button></a>}
          </div>
          {pkg && <div className="mt-2 text-[11px] text-faint">Built {ago(pkg.createdAt)}</div>}
        </Panel>
        {renders.length > 0 && (
          <Panel title="Render history">
            <ul className="space-y-2">
              {renders.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="truncate">{r.label}</span>
                  <a href={downloadUrl(r.id)} className="text-accent hover:underline">Download</a>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
