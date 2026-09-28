import { useQuery } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Field, PageHeader, Panel, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import type { Settings } from '../lib/types';

export function SettingsPage() {
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ ok: boolean; db: string; media: { ok: boolean; error?: string } }>('/health') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);
  const save = useAction(() => api.patch('/settings', s), { success: 'Settings saved', invalidate: [['settings']] });
  if (!s) return <div className="p-8"><Spinner /></div>;
  const m = s.mock;
  const setMock = (k: keyof Settings['mock'], v: number) => setS({ ...s, mock: { ...m, [k]: v } });
  return (
    <div className="mx-auto max-w-[900px] p-8">
      <PageHeader title="Settings" actions={<Button variant="primary" icon={<Save className="size-4" />} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <div className="space-y-5">
        <Panel title="System">
          <div className="flex gap-3 text-[12px]">
            <Badge tone={health.data?.db === 'ok' ? 'ok' : 'bad'}>Database {health.data?.db ?? '…'}</Badge>
            <Badge tone={health.data?.media.ok ? 'ok' : 'bad'}>ffmpeg {health.data ? (health.data.media.ok ? 'ok' : 'missing') : '…'}</Badge>
            {health.data?.media.error && <span className="text-bad">{health.data.media.error}</span>}
          </div>
          <p className="mt-3 text-[12px] text-muted">Provider API keys are read from server environment variables only and are never sent to the browser. See <code>.env.example</code>.</p>
        </Panel>
        <Panel title="Defaults">
          <Field label="Default project budget (USD)"><input type="number" className="input w-48" min={0} step={1} value={s.defaultBudgetUsd} onChange={(e) => setS({ ...s, defaultBudgetUsd: Number(e.target.value) })} /></Field>
        </Panel>
        <Panel title="Mock provider simulation">
          <p className="mb-4 text-[12px] text-muted">Tune how the mock provider behaves to rehearse failure handling. Include <code>[mock:fail]</code> or <code>[mock:timeout]</code> in a scene prompt to force an outcome.</p>
          <div className="grid grid-cols-2 gap-5">
            <Field label={`Latency: ${(m.latencyMs / 1000).toFixed(1)}s per task`}><input type="range" className="w-full" min={0} max={20000} step={250} value={m.latencyMs} onChange={(e) => setMock('latencyMs', Number(e.target.value))} /></Field>
            <Field label={`Deadline before timeout: ${(m.timeoutMs / 1000).toFixed(0)}s`}><input type="range" className="w-full" min={5000} max={300000} step={5000} value={m.timeoutMs} onChange={(e) => setMock('timeoutMs', Number(e.target.value))} /></Field>
            <Field label={`Random failure rate: ${Math.round(m.failureRate * 100)}%`}><input type="range" className="w-full" min={0} max={1} step={0.05} value={m.failureRate} onChange={(e) => setMock('failureRate', Number(e.target.value))} /></Field>
            <Field label={`Random timeout rate: ${Math.round(m.timeoutRate * 100)}%`}><input type="range" className="w-full" min={0} max={1} step={0.05} value={m.timeoutRate} onChange={(e) => setMock('timeoutRate', Number(e.target.value))} /></Field>
          </div>
        </Panel>
      </div>
    </div>
  );
}
