import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge, PageHeader, Panel, Progress, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { ago, usd } from '../lib/format';

interface Costs {
  totalUsd: number;
  byProject: { projectId: string | null; title: string; usd: number; budgetUsd: number | null }[];
  byProvider: { provider: string; model: string; capability: string; usd: number; n: number; simulated: boolean }[];
  ledger: { id: string; projectTitle: string | null; projectId: string | null; capability: string; provider: string; model: string; units: number; unit: string; unitCostUsd: number; amountUsd: number; kind: string; simulated: boolean; createdAt: string }[];
}

export function CostsPage() {
  const q = useQuery({ queryKey: ['costs'], queryFn: () => api.get<Costs>('/costs'), refetchInterval: 5000 });
  const d = q.data;
  return (
    <div className="mx-auto max-w-[1300px] p-8">
      <PageHeader title="Costs" subtitle="Estimates are recorded at submission and actuals on completion. Mock provider costs are simulated." />
      {q.isLoading || !d ? <Spinner /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Total spend" value={usd(d.totalUsd, 2)} sub="all projects · actuals" />
            <Stat label="Projects with spend" value={d.byProject.length} />
            <Stat label="Billable calls" value={d.byProvider.reduce((a, b) => a + b.n, 0)} />
          </div>
          <div className="grid grid-cols-2 gap-6">
            <Panel title="By project">
              <div className="space-y-3">
                {d.byProject.map((p) => (
                  <div key={p.projectId ?? 'lib'}>
                    <div className="flex justify-between text-[12px]">{p.projectId ? <Link className="hover:text-accent" to={`/projects/${p.projectId}/storyboard`}>{p.title}</Link> : <span>{p.title}</span>}<span className="tabular-nums">{usd(p.usd, 3)}{p.budgetUsd != null && <span className="text-faint"> / {usd(p.budgetUsd, 2)}</span>}</span></div>
                    {p.budgetUsd ? <Progress className="mt-1" value={p.usd / p.budgetUsd} tone={p.usd / p.budgetUsd > 0.9 ? 'warn' : 'accent'} /> : null}
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="By provider / model">
              <table className="w-full text-[12px]"><tbody>
                {d.byProvider.map((r) => (
                  <tr key={`${r.provider}${r.model}`} className="border-b border-line last:border-0"><td className="py-1.5">{r.provider} · {r.model} {r.simulated && <Badge>sim</Badge>}</td><td className="text-muted">{r.capability}</td><td className="text-muted tabular-nums">{r.n}×</td><td className="text-right tabular-nums">{usd(r.usd)}</td></tr>
                ))}
              </tbody></table>
            </Panel>
          </div>
          <Panel title="Ledger (latest 200)" bodyClassName="p-0">
            <table className="w-full text-[12px]">
              <thead className="text-left text-[11px] text-muted uppercase"><tr>{['When', 'Project', 'Kind', 'Provider · model', 'Units', 'Amount'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>{d.ledger.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="px-4 py-1.5 text-muted">{ago(e.createdAt)}</td><td className="px-4">{e.projectTitle ?? 'library'}</td>
                  <td className="px-4"><Badge tone={e.kind === 'actual' ? 'ok' : 'neutral'}>{e.kind}</Badge></td>
                  <td className="px-4">{e.provider} · {e.model} <span className="text-faint">({e.capability})</span></td>
                  <td className="px-4 tabular-nums text-muted">{e.units.toFixed(3)} {e.unit.replace('_', ' ')} × {usd(e.unitCostUsd)}</td>
                  <td className="px-4 tabular-nums">{usd(e.amountUsd)}{e.simulated && <span className="text-faint"> sim</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  );
}
