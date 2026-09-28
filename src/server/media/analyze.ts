/** Post-render media analysis: loudness (EBU R128), black frames and silences, in one ffmpeg pass. */
import { ffmpegStderr } from '../services/alignment';

export interface MediaAnalysis {
  integratedLufs: number | null;
  truePeakDb: number | null;
  blackSegments: { start: number; end: number }[];
  silentSegments: { start: number; end: number }[];
}

export async function analyzeRender(filePath: string): Promise<MediaAnalysis> {
  const stderr = await ffmpegStderr([
    '-i', filePath,
    '-filter_complex', '[0:v]blackdetect=d=0.5:pic_th=0.98:pix_th=0.10[v];[0:a]ebur128=peak=true,silencedetect=noise=-50dB:d=1.5[a]',
    '-map', '[v]', '-map', '[a]', '-f', 'null', '-',
  ]);
  const num = (re: RegExp) => { let m: RegExpExecArray | null; let last: number | null = null; const g = new RegExp(re.source, 'g'); while ((m = g.exec(stderr))) last = Number(m[1]); return last; };
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integratedLufs = summary ? num(/I:\s+(-?[\d.]+) LUFS/) : null;
  const truePeakDb = summary ? num(/Peak:\s+(-?[\d.]+) dBFS/) : null;
  const blackSegments: { start: number; end: number }[] = [];
  for (const m of stderr.matchAll(/black_start:(-?[\d.]+) black_end:([\d.]+)/g)) blackSegments.push({ start: Number(m[1]), end: Number(m[2]) });
  const silentSegments: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) { silentSegments.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  return { integratedLufs, truePeakDb, blackSegments, silentSegments };
}
