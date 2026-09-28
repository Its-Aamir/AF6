import { FileText, Mic, Plus, RefreshCw, Save, Scissors, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Empty, Field, Panel } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import type { ProjectState } from '../lib/types';
import type { ProjectActions } from './Studio';

export function ScriptTab({ state, actions }: { state: ProjectState; actions: ProjectActions }) {
  const p = state.project;
  const [title, setTitle] = useState(p.script?.title ?? '');
  const [sections, setSections] = useState(p.script?.sections ?? []);
  const serverKey = JSON.stringify(p.script);
  useEffect(() => { setTitle(p.script?.title ?? ''); setSections(p.script?.sections ?? []); }, [serverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!p.script && (title !== p.script.title || JSON.stringify(sections) !== JSON.stringify(p.script.sections));
  const words = useMemo(() => sections.map((s) => s.narration).join(' ').split(/\s+/).filter(Boolean).length, [sections]);
  const estSec = (words / p.recipeSnapshot.wordsPerMinute) * 60;
  const save = useAction((_: void, confirmReset) => api.put(`/projects/${p.id}/script`, { title, sections, confirmReset }), { projectId: p.id, success: 'Script saved' });
  const editable = !p.busy && p.status !== 'producing';

  return (
    <div className="grid grid-cols-[340px_1fr] gap-5 p-5">
      <div className="space-y-4">
        <Panel title="Input">
          <div className="space-y-3 text-[12px]">
            <div className="flex items-center gap-2"><Badge tone="accent">{p.inputMode === 'topic' ? 'Topic' : 'User script'}</Badge><span className="text-muted">Recipe: {p.recipeName}</span></div>
            {p.inputMode === 'topic'
              ? <p className="rounded-lg border border-line bg-bg p-3 leading-relaxed">{p.topic}</p>
              : <p className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 leading-relaxed whitespace-pre-wrap text-muted">{p.sourceScript}</p>}
            <Button className="w-full" variant={p.script ? 'secondary' : 'primary'} icon={p.script ? <RefreshCw className="size-3.5" /> : <FileText className="size-3.5" />}
              loading={actions.script.isPending || p.status === 'scripting'} disabled={p.busy || p.status === 'producing'} onClick={() => actions.script.mutate()}>
              {p.status === 'scripting' ? 'Writing…' : p.script ? (p.inputMode === 'topic' ? 'Regenerate script' : 'Re-analyse script') : p.inputMode === 'topic' ? 'Generate script' : 'Analyse script'}
            </Button>
            <p className="text-[11px] text-faint">{p.inputMode === 'topic' ? 'Structured output is validated against a strict schema before it is saved.' : 'Your narration is kept verbatim; the model only adds a title and section headings.'}</p>
          </div>
        </Panel>
        <Panel title="Recipe targets">
          <div className="grid grid-cols-2 gap-y-1.5 text-[12px] text-muted">
            <span>Target length</span><span className="text-fg">{p.recipeSnapshot.targetDurationSec}s</span>
            <span>Pacing</span><span className="text-fg">{p.recipeSnapshot.wordsPerMinute} wpm</span>
            <span>Tone</span><span className="text-fg">{p.recipeSnapshot.tone}</span>
            <span>Structure</span><span className="text-fg">{p.recipeSnapshot.structure.join(' → ')}</span>
          </div>
        </Panel>
        {p.script && (
          <Panel title="Next">
            <div className="space-y-2">
              <Button className="w-full" variant={p.status === 'scripted' ? 'primary' : 'secondary'} icon={<Mic className="size-3.5" />} loading={actions.narration.isPending || p.status === 'narrating'} disabled={p.busy || dirty || p.status === 'producing'} onClick={() => actions.narration.mutate()}>
                {p.narrationAssetId ? 'Regenerate narration' : 'Generate narration'}
              </Button>
              <Button className="w-full" icon={<Scissors className="size-3.5" />} disabled={!p.narrationAssetId || p.busy || p.status === 'producing'} loading={actions.segment.isPending} onClick={() => actions.segment.mutate()}>Split narration into scenes</Button>
              {dirty && <p className="text-[11px] text-warn">Save your edits before generating narration.</p>}
            </div>
          </Panel>
        )}
      </div>

      {!p.script ? (
        <Empty icon={<FileText className="size-6" />} title={p.status === 'scripting' ? 'Writing the script…' : 'No script yet'}>
          {p.status === 'scripting' ? 'This runs in the background. You can leave this page.' : 'Generate a script from the topic, or analyse your pasted script.'}
        </Empty>
      ) : (
        <Panel title={<span className="flex items-center gap-3">Script <span className="font-normal text-muted">{words} words · ≈{estSec.toFixed(0)}s at {p.recipeSnapshot.wordsPerMinute} wpm</span></span>}
          actions={<Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty || !editable} loading={save.isPending} onClick={() => save.mutate()}>Save edits</Button>}>
          <div className="space-y-4">
            <Field label="Title"><input className="input text-[15px] font-medium" value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} /></Field>
            {p.script.summary && <p className="text-[12px] text-muted">{p.script.summary}</p>}
            {sections.map((s, i) => (
              <div key={i} className="rounded-lg border border-line bg-panel-2 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-faint tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                  <input className="input flex-1 py-1 font-medium" value={s.heading} disabled={!editable} onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)))} />
                  <Button size="xs" variant="ghost" aria-label="Remove section" disabled={!editable || sections.length <= 1} icon={<Trash2 className="size-3.5" />} onClick={() => setSections(sections.filter((_, j) => j !== i))} />
                </div>
                <textarea className="input min-h-[90px] text-[13.5px] leading-relaxed" value={s.narration} disabled={!editable} onChange={(e) => setSections(sections.map((x, j) => (j === i ? { ...x, narration: e.target.value } : x)))} />
              </div>
            ))}
            <Button size="sm" variant="ghost" disabled={!editable} icon={<Plus className="size-3.5" />} onClick={() => setSections([...sections, { heading: 'New section', narration: '' }])}>Add section</Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
