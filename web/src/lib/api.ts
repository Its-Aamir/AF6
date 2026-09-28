/** Typed API client. The browser never holds secrets; all calls go to our own /api. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  get requiresConfirmation(): boolean {
    return this.code === 'CONFLICT' && !!(this.details as { requiresConfirmation?: boolean } | null)?.requiresConfirmation;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the studio server. Is it running?', null);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; details: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`, e?.details ?? null);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File) => { const fd = new FormData(); fd.append('file', file); return request<T>('POST', url, fd); },
};

export const assetUrl = (id: string) => `/api/assets/${id}/file`;
export const thumbUrl = (id: string) => `/api/assets/${id}/thumbnail`;
export const downloadUrl = (id: string) => `/api/assets/${id}/download`;
