import { CheckCircle2, CircleAlert, ShieldCheck, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { Badge, Button, Empty, Panel } from '../components/ui';
import { ago } from '../lib/format';
import type { ProjectState } from '../lib/types';
import type { ProjectActions } from './Studio';

const ORDER = ['fail', 'warn', 'pass'];

export function QaTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const r = p.qaReport;
  const canRun = ['assembled', 'qa_passed', 'qa_failed', 'rendered'].includes(p.status);
  const counts = r ? { pass: r.checks.filter((c) => c.status === 'pass').length, warn: r.checks.filter((c) => c.status === 'warn').length, fail: r.checks.filter((c) => c.status === 'fail').length } : null;
  return (
    <div className="mx-auto max-w-[1000px] space-y-4 p-5">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
        <ShieldCheck className="size-5 text-accent" />
        <div className="flex-1">
          <div className="font-medium">Pre-render quality checks</div>
          <div className="text-[12px] text-muted">Deterministic checks: coverage, missing files, clip lengths, aspect ratios, captions, music, timeline freshness, budget.</div>
        </div>
        <Button variant={p.status === 'assembled' ? 'primary' : 'secondary'} disabled={!canRun || p.busy} loading={actions.qa.isPending || p.status === 'qa_running'} onClick={() => actions.qa.mutate()}
          title={canRun ? undefined : 'Assemble the timeline first'}>{r ? 'Re-run QA' : 'Run QA'}</Button>
      </div>
      {!r ? (
        <Empty icon={<ShieldCheck className="size-6" />} title="QA has not run yet">{canRun ? 'Run QA to check the assembled timeline before rendering.' : 'Assemble the timeline first, then run QA.'}</Empty>
      ) : (
        <Panel title={<span className="flex items-center gap-2">{r.passed ? <Badge tone="ok">Passed</Badge> : <Badge tone="bad">Failed</Badge>}<span className="font-normal text-muted">ran {ago(r.ranAt)}</span></span>}
          actions={counts && <span className="text-[12px] text-muted">{counts.pass} pass · {counts.warn} warn · {counts.fail} fail</span>} bodyClassName="p-0">
          {!p.timelineCurrent && <div className="border-b border-line bg-warn/5 px-4 py-2 text-[12px] text-warn">The project changed after this report — re-assemble and re-run QA.</div>}
          <ul>
            {[...r.checks].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map((c) => (
              <li key={c.id} className="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-0">
                {c.status === 'pass' ? <CheckCircle2 className="mt-0.5 size-4 text-ok" /> : c.status === 'warn' ? <CircleAlert className="mt-0.5 size-4 text-warn" /> : <XCircle className="mt-0.5 size-4 text-bad" />}
                <div className="flex-1"><div className="font-medium">{c.label}</div><div className="text-[12px] text-muted">{c.message}</div></div>
                {c.sceneId && <Link to={`/projects/${p.id}/storyboard#scene-${state.scenes.find((s) => s.id === c.sceneId)?.index}`} className="text-[12px] text-accent hover:underline">Open scene</Link>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
