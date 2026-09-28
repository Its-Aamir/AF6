import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, ExternalLink, KeyRound, Link2, Plus, RefreshCw, Sparkles, Trash2, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../components/toast';
import { Badge, Button, ErrorNote, Field, Modal, PageHeader, Panel, Spinner, Toggle } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { ago } from '../lib/format';
import { useAction, useProviders } from '../lib/hooks';

interface ConnModel { id: string; capability: 'image' | 'video' | 'tts' | 'music' | 'llm' | 'stt'; label: string; enabled: boolean; unitCostUsd: number | null; unit: 'image' | 'second' | '1k_chars' | '1k_tokens' | 'minute'; durations?: number[]; source: string; extraInput?: Record<string, unknown>; notes?: string }
interface Conn {
  id: string; displayName: string; transport: 'api' | 'mcp'; capabilities: string[]; notes: string; defaultBaseUrl: string;
  connection: { method: 'api_key' | 'mcp_oauth'; summary: string; consoleUrl?: string; docsUrl?: string; fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string; optional?: boolean }[] };
  status: 'not_connected' | 'connected' | 'error' | 'authorization_required'; secretHint: string | null; baseUrl: string | null; lastTestedAt: string | null; lastError: string | null; models: ConnModel[];
}

const STATUS: Record<Conn['status'], [string, 'ok' | 'bad' | 'warn' | 'neutral']> = {
  connected: ['Connected', 'ok'], error: ['Error', 'bad'], authorization_required: ['Sign-in required', 'warn'], not_connected: ['Not connected', 'neutral'],
};

export function ProvidersPage() {
  const q = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Conn[]>('/connections') });
  const providers = useProviders();
  const mock = providers.data?.find((p) => p.id === 'mock');
  const [connecting, setConnecting] = useState<Conn | null>(null);
  return (
    <div className="mx-auto max-w-[1200px] p-8">
      <PageHeader title="Providers" subtitle="Connect a provider once — its models then appear in Channel Recipes and in every scene's model picker. Keys are encrypted on the server and never sent back to the browser." />
      <Recommendation />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorNote>{(q.error as Error).message}</ErrorNote> : (
        <div className="space-y-4">
          {q.data!.map((c) => <ConnectionCard key={c.id} c={c} onConnect={() => setConnecting(c)} />)}
        </div>
      )}
      {mock && (
        <Panel className="mt-4" title={<span className="flex items-center gap-2">{mock.displayName}<Badge>MOCK</Badge><Badge tone="ok">Always available</Badge></span>}>
          <p className="text-[12px] text-muted">Simulated generation for rehearsing the workflow — produces real files, costs are simulated, no credits used. {mock.models.filter((m) => m.capability === 'image' || m.capability === 'video').map((m) => m.label).join(' · ')}</p>
        </Panel>
      )}
      {connecting && <ConnectModal c={connecting} onClose={() => setConnecting(null)} />}
    </div>
  );
}

function Recommendation() {
  return (
    <div className="mb-5 rounded-xl border border-accent/25 bg-accent/5 p-4">
      <div className="flex items-center gap-2 font-medium"><Sparkles className="size-4 text-accent" />Which one should I connect?</div>
      <ul className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1.5 text-[12px] text-muted">
        <li><b className="text-fg">Fastest start, most models:</b> Higgsfield MCP — sign in with your Higgsfield account, no key to copy. Seedance, Kling, Veo, GPT Image and more behind one login.</li>
        <li><b className="text-fg">Best price for motion:</b> Kling API — text-to-video from $0.042/s (2.x) or $0.112/s (3.0 Turbo) with official per-second prices pre-filled.</li>
        <li><b className="text-fg">Highest-end cinematic video:</b> Google Veo — one Gemini API key gives Veo video and Gemini image models. Set your per-second price from your Google billing.</li>
        <li><b className="text-fg">Mix and match:</b> connect several. Use a cheap image model for most scenes and switch only hero scenes to video in the Storyboard.</li>
        <li><b className="text-fg">Voice:</b> ElevenLabs — realistic narration with exact word timing; also aligns voiceovers you upload.</li>
        <li><b className="text-fg">AI Director:</b> Claude — writes scripts and plans every scene's prompt and shot. Without it, a basic template planner is used.</li>
      </ul>
    </div>
  );
}

function ConnectionCard({ c, onConnect }: { c: Conn; onConnect: () => void }) {
  const qc = useQueryClient();
  const { confirm, toast } = useToast();
  const inv = { invalidate: [['connections'], ['providers']] };
  const test = useAction(() => api.post<{ status: string; message?: string; authorizationUrl?: string }>(`/connections/${c.id}/test`).then((r) => {
    if (r.authorizationUrl) { window.open(r.authorizationUrl, '_blank', 'noopener'); toast('info', 'Sign in again in the new tab'); }
    else if (r.message) toast('ok', 'Connection OK', r.message);
    return r;
  }), inv);
  const disconnect = useAction(() => api.del(`/connections/${c.id}`), { ...inv, success: `${c.displayName} disconnected` });
  const [label, tone] = STATUS[c.status];
  const connected = c.status === 'connected';
  const needPrice = c.models.filter((m) => m.enabled && m.unitCostUsd == null && m.capability !== 'llm' && m.capability !== 'stt').length;
  return (
    <Panel title={<span className="flex items-center gap-2">{c.displayName}<Badge>{c.transport === 'mcp' ? 'MCP' : 'API'}</Badge><Badge tone={tone}>{label}</Badge>
      {connected && needPrice > 0 && <Badge tone="warn"><CircleAlert className="size-3" />{needPrice} model{needPrice > 1 ? 's' : ''} need a price</Badge>}</span>}
      actions={<>
        {c.status !== 'not_connected' && <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>Test &amp; refresh models</Button>}
        {c.status !== 'not_connected' && <Button size="sm" variant="ghost" icon={<Unplug className="size-3.5" />} onClick={async () => { if (await confirm(`Disconnect ${c.displayName}?`, 'The stored credentials are deleted. Scenes set to its models will ask you to pick another model.', 'Disconnect')) disconnect.mutate(); }}>Disconnect</Button>}
        <Button size="sm" variant={connected ? 'secondary' : 'primary'} icon={c.connection.method === 'mcp_oauth' ? <Link2 className="size-3.5" /> : <KeyRound className="size-3.5" />} onClick={onConnect}>{connected ? 'Replace credentials' : c.status === 'authorization_required' ? 'Finish sign-in' : 'Connect'}</Button>
      </>}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>{c.notes}</span>
        {c.secretHint && <span>Credential: <code className="text-fg">{c.secretHint}</code></span>}
        {c.lastTestedAt && <span>Checked {ago(c.lastTestedAt)}</span>}
        {c.baseUrl && c.baseUrl !== c.defaultBaseUrl && <span>Endpoint: <code>{c.baseUrl}</code></span>}
      </div>
      {c.lastError && <div className="mt-3"><ErrorNote>{c.lastError}</ErrorNote></div>}
      {c.status !== 'not_connected' && c.models.length > 0 && <ModelTable c={c} onChanged={() => qc.invalidateQueries({ queryKey: ['providers'] })} />}
      {connected && c.id === 'higgsfield-api' && <AddEndpoint c={c} />}
    </Panel>
  );
}

function ModelTable({ c, onChanged }: { c: Conn; onChanged: () => void }) {
  const save = useAction((update: Partial<ConnModel> & { id: string; capability: string }) => api.patch(`/connections/${c.id}/models`, { update: [update] }).then(onChanged), { invalidate: [['connections']] });
  const remove = useAction((m: ConnModel) => api.patch(`/connections/${c.id}/models`, { remove: [{ id: m.id, capability: m.capability }] }).then(onChanged), { invalidate: [['connections']] });
  const [showAll, setShowAll] = useState(false);
  const rows = showAll || c.models.length <= 12 ? c.models : c.models.filter((m) => m.enabled);
  return (
    <div className="mt-4">
      <table className="w-full text-[12px]">
        <thead className="text-left text-[11px] text-muted uppercase"><tr>
          <th className="pb-1.5 font-medium">Use</th><th className="font-medium">Model</th><th className="font-medium">Type</th><th className="font-medium">Price (USD)</th><th className="font-medium">Durations (s)</th><th />
        </tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={`${m.capability}:${m.id}`} className="border-t border-line align-middle">
              <td className="py-1.5 pr-2"><Toggle checked={m.enabled} onChange={(v) => save.mutate({ id: m.id, capability: m.capability, enabled: v })} /></td>
              <td className="pr-3"><div className={clsx(!m.enabled && 'text-muted')}>{m.label}</div><div className="text-[10.5px] text-faint">{m.id}{m.notes ? ` · ${m.notes}` : ''}</div></td>
              <td><Badge>{m.capability}</Badge></td>
              <td>{m.capability === 'llm' ? <span className="text-faint">billed per token (automatic)</span> : m.capability === 'stt' ? <span className="text-faint">included in your plan</span> : <PriceInput m={m} onSave={(v) => save.mutate({ id: m.id, capability: m.capability, unitCostUsd: v })} />}</td>
              <td>{m.capability === 'video' ? <DurationsInput m={m} onSave={(d) => save.mutate({ id: m.id, capability: m.capability, durations: d })} /> : <span className="text-faint">—</span>}</td>
              <td className="text-right">{m.source === 'custom' && <Button size="xs" variant="ghost" aria-label="Remove model" icon={<Trash2 className="size-3" />} onClick={() => remove.mutate(m)} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {c.models.length > 12 && <button className="mt-2 text-[12px] text-accent hover:underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show enabled only' : `Show all ${c.models.length} models`}</button>}
      <p className="mt-2 text-[11px] text-faint">Prices feed the per-project budget guard and cost ledger. Pre-filled prices come from the provider's official price list — adjust them to your plan. Generation is blocked for a model without a price.</p>
    </div>
  );
}

function PriceInput({ m, onSave }: { m: ConnModel; onSave: (v: number | null) => void }) {
  const [v, setV] = useState(m.unitCostUsd == null ? '' : String(m.unitCostUsd));
  useEffect(() => setV(m.unitCostUsd == null ? '' : String(m.unitCostUsd)), [m.unitCostUsd]);
  const commit = () => { const n = v.trim() === '' ? null : Number(v); if (n !== m.unitCostUsd && (n === null || (Number.isFinite(n) && n >= 0))) onSave(n); };
  return (
    <label className="flex items-center gap-1">
      <input className={clsx('input w-20 py-0.5 text-[12px]', m.enabled && m.unitCostUsd == null && 'border-warn/60')} inputMode="decimal" placeholder="set" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      <span className="text-faint">/{m.unit === 'second' ? 's' : m.unit === '1k_chars' ? '1k chars' : 'img'}</span>
    </label>
  );
}

function DurationsInput({ m, onSave }: { m: ConnModel; onSave: (d: number[]) => void }) {
  const cur = (m.durations ?? []).join(', ');
  const [v, setV] = useState(cur);
  useEffect(() => setV(cur), [cur]);
  const commit = () => {
    const d = v.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 120);
    if (d.length && d.join(', ') !== cur) onSave([...new Set(d)].sort((a, b) => a - b));
  };
  return <input className="input w-36 py-0.5 text-[12px]" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} title="Allowed clip lengths; the closest one covering the scene is requested" />;
}

function AddEndpoint({ c }: { c: Conn }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: '', label: '', capability: 'video' as 'image' | 'video', price: '', durations: '5, 10', extra: '' });
  const [err, setErr] = useState<string | null>(null);
  const add = useAction(async () => {
    setErr(null);
    let extraInput: Record<string, unknown> | undefined;
    if (f.extra.trim()) { try { extraInput = JSON.parse(f.extra); } catch { setErr('Extra input must be a JSON object'); throw new Error('Extra input must be JSON'); } }
    await api.patch(`/connections/${c.id}/models`, { add: [{ id: f.id.trim(), label: f.label.trim() || f.id.trim(), capability: f.capability, unitCostUsd: f.price ? Number(f.price) : null, durations: f.capability === 'video' ? f.durations.split(/[,\s]+/).map(Number).filter((n) => n > 0) : undefined, extraInput }] });
    setOpen(false);
  }, { success: 'Endpoint added', invalidate: [['connections'], ['providers']] });
  return (
    <>
      <Button size="sm" variant="ghost" className="mt-3" icon={<Plus className="size-3.5" />} onClick={() => setOpen(true)}>Add Higgsfield endpoint</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a Higgsfield endpoint" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!f.id.trim()} onClick={() => add.mutate()}>Add</Button></>}>
        <div className="space-y-3">
          <p className="text-[12px] text-muted">Higgsfield models are addressed by endpoint path — copy it from the Higgsfield console or docs (for example <code>flux-pro/kontext/max/text-to-image</code>). We send <code>prompt</code>, <code>aspect_ratio</code> and, for video, <code>duration</code>, plus any extra input below.</p>
          <Field label="Endpoint path"><input className="input" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="vendor/model/text-to-video" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
            <Field label="Type"><select className="input" value={f.capability} onChange={(e) => setF({ ...f, capability: e.target.value as 'video' })}><option value="video">Video</option><option value="image">Image</option></select></Field>
            <Field label={`Price (USD per ${f.capability === 'video' ? 'second' : 'image'})`}><input className="input" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            {f.capability === 'video' && <Field label="Allowed durations (s)"><input className="input" value={f.durations} onChange={(e) => setF({ ...f, durations: e.target.value })} /></Field>}
          </div>
          <Field label="Extra input (JSON, optional)" hint="Merged into every request for this endpoint, e.g. {&quot;resolution&quot;: &quot;720p&quot;}"><textarea className="input font-mono text-[12px]" rows={3} value={f.extra} onChange={(e) => setF({ ...f, extra: e.target.value })} /></Field>
          {err && <ErrorNote>{err}</ErrorNote>}
        </div>
      </Modal>
    </>
  );
}

function ConnectModal({ c, onClose }: { c: Conn; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  // While waiting for OAuth sign-in in another tab, poll until connected.
  useEffect(() => {
    if (!waiting) return;
    const done = async () => {
      const list = await api.get<Conn[]>('/connections');
      const me = list.find((x) => x.id === c.id);
      if (me?.status === 'connected') { await qc.invalidateQueries({ queryKey: ['connections'] }); await qc.invalidateQueries({ queryKey: ['providers'] }); toast('ok', `${c.displayName} connected`); onClose(); }
      else if (me?.status === 'error') { setErr(me.lastError ?? 'Sign-in failed'); setWaiting(false); }
    };
    const t = setInterval(() => void done(), 1500);
    const onMsg = (e: MessageEvent) => { if ((e.data as { type?: string })?.type === 'af6-provider-connected') void done(); };
    window.addEventListener('message', onMsg);
    return () => { clearInterval(t); window.removeEventListener('message', onMsg); };
  }, [waiting, c.id, c.displayName, qc, toast, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.put<{ status: string; message?: string; authorizationUrl?: string }>(`/connections/${c.id}`, { fields, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) });
      if (r.authorizationUrl) {
        window.open(r.authorizationUrl, '_blank', 'noopener');
        setWaiting(true);
      } else {
        toast('ok', `${c.displayName} connected`, r.message);
        await qc.invalidateQueries({ queryKey: ['connections'] });
        await qc.invalidateQueries({ queryKey: ['providers'] });
        onClose();
      }
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Connect ${c.displayName}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[12px] text-muted">{c.connection.summary}</p>
        <div className="flex gap-3 text-[12px]">
          {c.connection.consoleUrl && <a className="flex items-center gap-1 text-accent hover:underline" href={c.connection.consoleUrl} target="_blank" rel="noreferrer">Get credentials <ExternalLink className="size-3" /></a>}
          {c.connection.docsUrl && <a className="flex items-center gap-1 text-accent hover:underline" href={c.connection.docsUrl} target="_blank" rel="noreferrer">Docs <ExternalLink className="size-3" /></a>}
        </div>
        {c.connection.fields.map((f) => (
          <Field key={f.key} label={`${f.label}${f.optional ? ' (optional)' : ''}`} hint={f.help}>
            <input className="input font-mono" type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
          </Field>
        ))}
        {c.connection.method === 'api_key' && (
          <details className="text-[12px] text-muted">
            <summary className="cursor-pointer">Advanced: API endpoint</summary>
            <input className="input mt-2 font-mono" placeholder={c.defaultBaseUrl} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </details>
        )}
        {waiting && <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-[12px]"><Spinner />Finish signing in to {c.displayName} in the new tab — this dialog closes automatically.</div>}
        {err && <ErrorNote onDismiss={() => setErr(null)}>{err}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={waiting} icon={<CheckCircle2 className="size-3.5" />}>{c.connection.method === 'mcp_oauth' && !fields.bearerToken ? 'Sign in with Higgsfield' : 'Verify & connect'}</Button>
        </div>
        <p className="text-[11px] text-faint">Credentials are checked with a free request before saving, then encrypted at rest (AES-256-GCM). They are never shown again or sent to the browser.</p>
      </form>
    </Modal>
  );
}

