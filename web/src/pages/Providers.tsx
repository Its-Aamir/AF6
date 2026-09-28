import { CheckCircle2, CircleDashed, KeyRound } from 'lucide-react';
import { Badge, PageHeader, Panel, Spinner } from '../components/ui';
import { usd } from '../lib/format';
import { useProviders } from '../lib/hooks';

export function ProvidersPage() {
  const q = useProviders();
  return (
    <div className="mx-auto max-w-[1200px] p-8">
      <PageHeader title="Providers" subtitle="Generation backends behind a common adapter interface. Credentials stay on the server; this page only shows whether they are present." />
      {q.isLoading ? <Spinner /> : (
        <div className="space-y-4">
          {q.data?.map((p) => (
            <Panel key={p.id} title={<span className="flex items-center gap-2">{p.displayName}<Badge>{p.transport.toUpperCase()}</Badge>
              {p.implemented ? <Badge tone="ok"><CheckCircle2 className="size-3" />Implemented</Badge> : <Badge tone="warn"><CircleDashed className="size-3" />Adapter pending</Badge>}
              {p.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="neutral"><KeyRound className="size-3" />Not configured</Badge>}</span>}>
              <div className="grid grid-cols-[1fr_1.4fr] gap-6">
                <div className="space-y-2 text-[12px] text-muted">
                  <div>Capabilities: {p.capabilities.map((c) => <Badge key={c} className="mr-1">{c}</Badge>)}</div>
                  {p.notes && <div>{p.notes}</div>}
                  {!p.implemented && <div className="rounded-lg border border-warn/25 bg-warn/5 p-2.5 text-warn">Integration is not built yet. It will be implemented against the provider's current official documentation once credentials are available. It cannot be selected for generation.</div>}
                  {p.requiredEnv.length > 0 && <div>Server env: {p.requiredEnv.map((k) => <code key={k} className={`mr-2 ${p.missingEnv.includes(k) ? 'text-faint' : 'text-ok'}`}>{k}{p.missingEnv.includes(k) ? ' (missing)' : ' ✓'}</code>)}</div>}
                </div>
                {p.models.length > 0 ? (
                  <table className="w-full text-[12px]">
                    <thead className="text-left text-[11px] text-muted uppercase"><tr><th className="pb-1.5 font-medium">Model</th><th className="font-medium">Type</th><th className="font-medium">Price</th><th className="font-medium">Limit</th></tr></thead>
                    <tbody>{p.models.map((m) => (
                      <tr key={m.id} className="border-t border-line"><td className="py-1.5">{m.label}<div className="text-[11px] text-faint">{m.id}</div></td><td>{m.capability}</td>
                        <td className="tabular-nums">{usd(m.unitCostUsd)} / {m.unit.replace('_', ' ')}{p.transport === 'mock' && <span className="text-faint"> (sim)</span>}</td><td>{m.maxDurationSec ? `${m.maxDurationSec}s` : '—'}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <div className="text-[12px] text-faint">Models will be listed once the adapter is implemented.</div>}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
