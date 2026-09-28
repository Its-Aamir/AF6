export type ErrorCode =
  | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INVALID_STATE' | 'CONFLICT' | 'BUDGET_EXCEEDED'
  | 'PROVIDER_NOT_AVAILABLE' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT' | 'LLM_OUTPUT_INVALID'
  | 'MEDIA_ERROR' | 'UPLOAD_REJECTED' | 'JOB_TIMEOUT' | 'CANCELLED' | 'INTERNAL';

const HTTP: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400, NOT_FOUND: 404, INVALID_STATE: 409, CONFLICT: 409, BUDGET_EXCEEDED: 402,
  PROVIDER_NOT_AVAILABLE: 422, PROVIDER_ERROR: 502, PROVIDER_TIMEOUT: 504, LLM_OUTPUT_INVALID: 502,
  MEDIA_ERROR: 500, UPLOAD_REJECTED: 415, JOB_TIMEOUT: 504, CANCELLED: 409, INTERNAL: 500,
};

/** Default retryability for job handling (can be overridden per instance). */
const RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  PROVIDER_ERROR: true, PROVIDER_TIMEOUT: true, JOB_TIMEOUT: true, MEDIA_ERROR: true, INTERNAL: true, LLM_OUTPUT_INVALID: true,
};

export class AppError extends Error {
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(public readonly code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.httpStatus = HTTP[code];
    this.retryable = opts.retryable ?? RETRYABLE[code] ?? false;
    this.details = opts.details;
  }
  details: unknown;
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
export const invalidState = (message: string, details?: unknown) => new AppError('INVALID_STATE', message, { details });

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err && typeof err === 'object' && (err as Error).name === 'InvalidTransitionError') {
    return new AppError('INVALID_STATE', (err as Error).message);
  }
  if (err && typeof err === 'object' && (err as Error).name === 'AbortError') {
    return new AppError('JOB_TIMEOUT', 'Operation timed out or was aborted');
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL', msg, { cause: err });
}
