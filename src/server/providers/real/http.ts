/** Small fetch wrapper for provider APIs: timeouts, JSON, and error classification. */
import { AppError } from '../../errors';

export interface HttpResult<T = unknown> { status: number; json: T; text: string }

export async function httpJson<T = unknown>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HttpResult<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), opts.timeoutMs ?? 60_000);
  const onAbort = () => ctl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: { Accept: 'application/json', ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl.signal,
      redirect: 'follow',
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new AppError('JOB_TIMEOUT', 'Request aborted');
    throw new AppError('PROVIDER_ERROR', `Network error calling ${new URL(url).host}: ${(e as Error).message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json: json as T, text };
}

/** Classify an HTTP failure. Auth/validation/moderation are not retryable; 429/5xx are. */
export function httpError(provider: string, status: number, message: string): AppError {
  const retryable = status === 429 || status >= 500;
  if (status === 401 || status === 403) return new AppError('PROVIDER_NOT_AVAILABLE', `${provider} rejected the credentials (${status}): ${message}. Reconnect it on the Providers page.`, { retryable: false });
  return new AppError('PROVIDER_ERROR', `${provider} error ${status}: ${message}`.slice(0, 1000), { retryable });
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch { return false; }
}

/** Pick the smallest allowed duration that covers the scene, else the longest allowed. */
export function pickDuration(allowed: number[] | undefined, wantSec: number, fallbackMax = 8): number {
  const opts = (allowed?.length ? [...allowed] : [Math.min(fallbackMax, Math.max(1, Math.ceil(wantSec)))]).sort((a, b) => a - b);
  return opts.find((d) => d >= wantSec - 0.05) ?? opts[opts.length - 1];
}

export function aspectFrom(width?: number, height?: number): '16:9' | '9:16' | '1:1' {
  if (!width || !height) return '16:9';
  const r = width / height;
  return r > 1.2 ? '16:9' : r < 0.83 ? '9:16' : '1:1';
}
