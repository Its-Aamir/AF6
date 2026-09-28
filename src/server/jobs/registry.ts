import type { JobHandler } from './types';
import { ALL_HANDLERS } from './handlers';

const handlers = new Map<string, JobHandler<never>>(ALL_HANDLERS.map((h) => [h.type, h]));

export function getHandler(type: string): JobHandler<unknown> | undefined {
  return handlers.get(type) as JobHandler<unknown> | undefined;
}

/** Test hook: register an extra handler (e.g. a controllable fake). */
export function registerHandler(h: JobHandler<never>): void {
  handlers.set(h.type, h);
}
