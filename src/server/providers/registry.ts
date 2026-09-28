import type { Capability } from '../../shared/schemas';
import { config } from '../config';
import { AppError } from '../errors';
import { MockProvider } from './mock';
import { STUB_PROVIDERS } from './stubs';
import type { GenerationProvider, ModelInfo } from './types';

const providers = new Map<string, GenerationProvider>();
for (const p of [new MockProvider(), ...STUB_PROVIDERS]) providers.set(p.id, p);

export function listProviders(): GenerationProvider[] {
  return [...providers.values()];
}

/** Test-only hook to register fakes (e.g. failing providers). */
export function registerProvider(p: GenerationProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): GenerationProvider {
  const p = providers.get(id);
  if (!p) throw new AppError('PROVIDER_NOT_AVAILABLE', `Unknown provider "${id}"`, { retryable: false });
  return p;
}

/**
 * Resolve a provider/model pair for a capability, refusing anything unusable.
 * Never falls back to another provider silently.
 */
export function resolveModel(capability: Capability, providerId: string, modelId: string): { provider: GenerationProvider; model: ModelInfo } {
  const provider = getProvider(providerId);
  if (!provider.implemented) {
    throw new AppError('PROVIDER_NOT_AVAILABLE', `${provider.displayName} is not implemented yet; choose another provider.`, { retryable: false });
  }
  if (config.isTest && provider.transport !== 'mock') {
    throw new AppError('PROVIDER_NOT_AVAILABLE', 'Real providers are disabled in the test environment (no real credits in tests).', { retryable: false });
  }
  const status = provider.configStatus();
  if (!status.configured) {
    throw new AppError('PROVIDER_NOT_AVAILABLE', `${provider.displayName} is not configured (missing: ${status.missingEnv.join(', ')}).`, { retryable: false });
  }
  if (!provider.capabilities.includes(capability)) {
    throw new AppError('PROVIDER_NOT_AVAILABLE', `${provider.displayName} does not support ${capability}.`, { retryable: false });
  }
  const model = provider.models.find((m) => m.id === modelId && m.capability === capability);
  if (!model) throw new AppError('PROVIDER_NOT_AVAILABLE', `Model "${modelId}" is not a ${capability} model of ${provider.displayName}.`, { retryable: false });
  return { provider, model };
}

export function findVoice(voiceId: string) {
  for (const p of providers.values()) {
    const v = p.voices?.find((x) => x.id === voiceId);
    if (v) return { provider: p, voice: v };
  }
  return null;
}
