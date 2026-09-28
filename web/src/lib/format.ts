export const usd = (n: number | null | undefined, digits = 3) => (n == null ? '—' : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : digits)}`);
export const secs = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}s`);
export function timecode(sec: number, withFrac = true): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${withFrac ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
export function ago(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.max(0, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
export const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
export const JOB_LABEL: Record<string, string> = {
  'script.generate': 'Script', 'narration.generate': 'Narration', 'scenes.segment': 'Scene split', 'visuals.plan': 'Visual plan',
  'scene.generate': 'Scene visual', 'music.generate': 'Music', 'qa.run': 'QA', 'render.final': 'Render', 'package.export': 'Package', 'voice.preview': 'Voice preview',
};
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', scripting: 'Writing script', scripted: 'Script ready', narrating: 'Narrating', narrated: 'Narration ready', segmenting: 'Splitting scenes',
  segmented: 'Scenes ready', planning: 'Planning visuals', planned: 'Visuals planned', producing: 'Generating assets', assets_ready: 'Assets ready',
  assembled: 'Timeline assembled', qa_running: 'Running QA', qa_passed: 'QA passed', qa_failed: 'QA failed', rendering: 'Rendering', rendered: 'Rendered',
};
