/**
 * ElevenLabs — narration (TTS with timestamps) and transcription (speech-to-text).
 * Built against the official SDK @elevenlabs/elevenlabs-js v2.69 (wire format):
 *   Auth:   xi-api-key header, base https://api.elevenlabs.io
 *   TTS:    POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128
 *           body {text, model_id} → {audio_base64, alignment:{characters[], character_start_times_seconds[], character_end_times_seconds[]}}
 *   Voices: GET /v1/voices → {voices:[{voice_id, name, category, labels, preview_url}]}
 *   Models: GET /v1/models → [{model_id, name, can_do_text_to_speech}]
 *   STT:    POST /v1/speech-to-text multipart {model_id: scribe_v2, file, timestamps_granularity: word}
 *           → {text, words:[{text, start, end, type: word|spacing|audio_event}]}
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WordTiming } from '../../../shared/schemas';
import type { ConnectionModel } from '../../db/schema';
import { AppError } from '../../errors';
import { getStorage } from '../../storage/storage';
import { getConnection } from '../connections';
import type { ConnectionSpec, CostEstimate, GenerationRequest, PollResult, ProviderContext, VoiceInfo } from '../types';
import { RealProvider, type TestResult } from './base';
import { httpError, httpJson } from './http';

interface Secret { apiKey: string }
export const VOICE_PREFIX = 'el:';

/** Convert ElevenLabs character alignment into word timings (whitespace-delimited). */
export function wordsFromAlignment(a: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): WordTiming[] {
  const words: WordTiming[] = [];
  let cur = '';
  let start = 0;
  let end = 0;
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (/\s/.test(ch)) {
      if (cur) words.push({ word: cur, start: round3(start), end: round3(end) });
      cur = '';
      continue;
    }
    if (!cur) start = a.character_start_times_seconds[i];
    cur += ch;
    end = a.character_end_times_seconds[i];
  }
  if (cur) words.push({ word: cur, start: round3(start), end: round3(end) });
  return words;
}

export class ElevenLabsProvider extends RealProvider {
  id = 'elevenlabs';
  displayName = 'ElevenLabs';
  transport = 'api' as const;
  capabilities = ['tts'] as RealProvider['capabilities'];
  defaultBaseUrl = 'https://api.elevenlabs.io';
  notes = 'Narration voices with exact word timings, plus transcription to align uploaded voiceovers.';
  connection: ConnectionSpec = {
    method: 'api_key',
    summary: 'Paste an ElevenLabs API key. Your voices (including cloned voices) and TTS models are discovered automatically. Set your price per 1,000 characters from your plan.',
    consoleUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps',
    fields: [{ key: 'apiKey', label: 'ElevenLabs API key', secret: true, placeholder: 'sk_…' }],
  };

  private headers(apiKey = this.secret<Secret>().apiKey) { return { 'xi-api-key': apiKey }; }

  get voices(): VoiceInfo[] {
    const v = getConnection(this.id)?.config.voices as { id: string; name: string; category?: string }[] | undefined;
    return (v ?? []).map((x) => ({ id: `${VOICE_PREFIX}${x.id}`, label: x.name, description: x.category ? `ElevenLabs · ${x.category}` : 'ElevenLabs', basePitch: 0, rateFactor: 1 }));
  }

  parseCredentials(f: Record<string, string>) {
    const apiKey = (f.apiKey ?? '').trim();
    if (apiKey.length < 16) throw new AppError('VALIDATION_ERROR', 'Enter your ElevenLabs API key.');
    return { secret: { apiKey } satisfies Secret, hint: `…${apiKey.slice(-4)}` };
  }

  async test(secret: unknown, config: Record<string, unknown>, signal?: AbortSignal): Promise<TestResult> {
    const base = ((typeof config.baseUrl === 'string' && config.baseUrl) || this.defaultBaseUrl).replace(/\/+$/, '');
    const h = this.headers((secret as Secret).apiKey);
    const models = await httpJson<{ model_id: string; name?: string; can_do_text_to_speech?: boolean; description?: string }[] | { detail?: unknown }>(`${base}/v1/models`, { headers: h, signal, timeoutMs: 20_000 });
    if (models.status !== 200 || !Array.isArray(models.json)) throw httpError('ElevenLabs', models.status, JSON.stringify((models.json as { detail?: unknown })?.detail ?? models.text).slice(0, 200));
    const voices = await httpJson<{ voices?: { voice_id: string; name?: string; category?: string }[] }>(`${base}/v1/voices`, { headers: h, signal, timeoutMs: 20_000 });
    if (voices.status !== 200) throw httpError('ElevenLabs', voices.status, voices.text.slice(0, 200));
    const tts: ConnectionModel[] = models.json.filter((m) => m.can_do_text_to_speech).map((m, i) => ({
      id: m.model_id, capability: 'tts', label: m.name ?? m.model_id, enabled: i === 0 || /multilingual_v2/.test(m.model_id), unitCostUsd: null, unit: '1k_chars', source: 'discovered', notes: m.description?.slice(0, 160),
    }));
    const stt: ConnectionModel = { id: 'scribe_v2', capability: 'stt', label: 'Scribe v2 (transcription for uploaded voiceovers)', enabled: true, unitCostUsd: null, unit: 'minute', source: 'catalog' };
    const voiceList = (voices.json.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name ?? v.voice_id, category: v.category }));
    return {
      models: [...tts, stt],
      config: { voices: voiceList },
      message: `Key accepted. ${voiceList.length} voice(s) and ${tts.length} TTS model(s) found. Pick a voice on the Audio tab or in a Channel Recipe, and set a price per 1,000 characters.`,
    };
  }

  estimateCost(req: GenerationRequest): CostEstimate {
    const m = this.model(req);
    if (m.unitCostUsd == null) throw new AppError('PROVIDER_NOT_AVAILABLE', `Set a price per 1,000 characters for ElevenLabs · ${m.label} on the Providers page.`, { retryable: false });
    const units = Math.max(0.001, (req.text ?? req.prompt).length / 1000);
    return { units, unit: '1k_chars', unitCostUsd: m.unitCostUsd, amountUsd: Math.round(units * m.unitCostUsd * 10000) / 10000, simulated: false };
  }

  /** Synchronous API: audio + alignment are stored immediately; poll() returns them (crash-safe). */
  async submit(req: GenerationRequest, ctx: ProviderContext): Promise<{ externalId: string }> {
    if (req.capability !== 'tts') throw new AppError('PROVIDER_NOT_AVAILABLE', 'ElevenLabs adapter handles narration only', { retryable: false });
    const voiceId = (req.voiceId ?? '').replace(VOICE_PREFIX, '');
    if (!voiceId) throw new AppError('VALIDATION_ERROR', 'Choose an ElevenLabs voice for this project.', { retryable: false });
    const r = await httpJson<{ audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }; detail?: unknown }>(
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      { headers: this.headers(), body: { text: req.text ?? req.prompt, model_id: req.model }, signal: ctx.signal, timeoutMs: 300_000 },
    );
    if (r.status !== 200 || !r.json?.audio_base64) throw httpError('ElevenLabs', r.status, JSON.stringify(r.json?.detail ?? r.text).slice(0, 300));
    const words = r.json.alignment ? wordsFromAlignment(r.json.alignment) : [];
    const id = randomUUID();
    const storage = getStorage();
    await storage.putBuffer(`provider-results/elevenlabs/${id}.mp3`, Buffer.from(r.json.audio_base64, 'base64'));
    await storage.putBuffer(`provider-results/elevenlabs/${id}.json`, Buffer.from(JSON.stringify({ words })));
    return { externalId: `file:${id}` };
  }

  async poll(externalId: string): Promise<PollResult> {
    const id = externalId.replace(/^file:/, '');
    const storage = getStorage();
    const audio = storage.resolve(`provider-results/elevenlabs/${id}.mp3`);
    let words: WordTiming[] = [];
    try { words = JSON.parse(await fs.readFile(storage.resolve(`provider-results/elevenlabs/${id}.json`), 'utf8')).words; }
    catch { throw new AppError('PROVIDER_ERROR', 'Stored narration is missing; will regenerate.', { retryable: true }); }
    return { status: 'succeeded', progress: 1, output: { kind: 'file', path: audio, ext: 'mp3', mime: 'audio/mpeg', words, metadata: { timing: 'tts_timestamps' } } };
  }

  /** Word-level transcription of an audio file (for uploaded voiceovers). */
  async transcribe(filePath: string, signal?: AbortSignal): Promise<{ text: string; words: WordTiming[] }> {
    const form = new FormData();
    form.append('model_id', 'scribe_v2');
    form.append('timestamps_granularity', 'word');
    form.append('file', new Blob([await fs.readFile(filePath)]), path.basename(filePath));
    const res = await fetch(`${this.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: this.headers(), body: form, signal });
    const text = await res.text();
    let json: { text?: string; words?: { text: string; start?: number; end?: number; type: string }[]; detail?: unknown } = {};
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok) throw httpError('ElevenLabs transcription', res.status, JSON.stringify(json.detail ?? text).slice(0, 300));
    const words = (json.words ?? []).filter((w) => w.type === 'word' && w.start != null && w.end != null).map((w) => ({ word: w.text.trim(), start: w.start!, end: w.end! }));
    return { text: json.text ?? '', words };
  }

  canTranscribe(): boolean {
    return this.configStatus().configured && this.connectionModels.some((m) => m.capability === 'stt' && m.enabled);
  }
}

function round3(n: number) { return Math.round(n * 1000) / 1000; }
