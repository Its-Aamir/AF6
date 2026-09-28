import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/toast';
import { api, ApiError } from './api';
import type { Provider, ProjectState, Recipe, Voice } from './types';

/** Project state: fast polling while anything is running so progress is live; survives refresh (server is source of truth). */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<ProjectState>(`/projects/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return 5000;
      return d.activeJobs > 0 || d.project.busy || d.project.status === 'producing' ? 1000 : 8000;
    },
  });
}

export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: () => api.get<Provider[]>('/providers'), staleTime: 60_000 });
export const useRecipes = () => useQuery({ queryKey: ['recipes'], queryFn: () => api.get<Recipe[]>('/recipes') });
export const useVoices = () => useQuery({ queryKey: ['voices'], queryFn: () => api.get<Voice[]>('/voices'), staleTime: 60_000 });

/**
 * Wraps a server action: shows errors (never silently fails), invalidates project
 * state, and handles "this will replace X — confirm?" responses by asking the user
 * and retrying with confirmReset.
 */
export function useAction<A = void>(fn: (arg: A, confirmReset: boolean) => Promise<unknown>, opts: { success?: string; projectId?: string; invalidate?: string[][] } = {}) {
  const qc = useQueryClient();
  const { toast, confirm } = useToast();
  return useMutation({
    mutationFn: async (arg: A) => {
      try {
        return await fn(arg, false);
      } catch (e) {
        if (e instanceof ApiError && e.requiresConfirmation) {
          const ok = await confirm('Replace downstream work?', e.message, 'Replace');
          if (!ok) return null;
          return fn(arg, true);
        }
        throw e;
      }
    },
    onSuccess: (res) => {
      if (res !== null && opts.success) toast('ok', opts.success);
    },
    onError: (e) => {
      const err = e as ApiError;
      toast('error', err.code === 'BUDGET_EXCEEDED' ? 'Budget exceeded' : err.code === 'INVALID_STATE' ? 'Not possible right now' : 'Action failed', err.message);
    },
    onSettled: async () => {
      if (opts.projectId) await qc.invalidateQueries({ queryKey: ['project', opts.projectId] });
      for (const k of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: k });
    },
  });
}
