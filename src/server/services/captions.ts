/** Deterministic caption cue building from narration word timings. */
import type { CaptionCue, WordTiming } from '../../shared/schemas';

export function buildCaptionCues(words: WordTiming[], maxChars: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: WordTiming[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(' ').slice(0, 200) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const nextLen = cur.map((x) => x.word).join(' ').length + (cur.length ? 1 : 0) + w.word.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (nextLen > maxChars || gap > 0.6)) flush();
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.word)) flush();
  }
  flush();
  // Close small gaps so captions don't flicker between cues.
  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (gap > 0 && gap < 0.35) cues[i].end = cues[i + 1].start;
  }
  return cues.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) }));
}

function ts(sec: number, sep: ',' | '.'): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`).join('\n');
}

/** ASS subtitle file for burning captions. Text is sanitised: no override tags possible. */
export function toAss(cues: CaptionCue[], width: number, height: number, position: 'bottom' | 'center'): string {
  const fontSize = Math.round(Math.min(width, height) * (position === 'center' ? 0.075 : 0.06));
  const align = position === 'center' ? 5 : 2;
  const marginV = Math.round(height * 0.08);
  const assTime = (sec: number) => {
    const cs = Math.round(sec * 100);
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const clean = (t: string) => t.replace(/[{}\\]/g, '').replace(/\n/g, ' ');
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(fontSize / 12))},1,${align},${Math.round(width * 0.08)},${Math.round(width * 0.08)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${clean(c.text)}`),
    '',
  ].join('\n');
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }
