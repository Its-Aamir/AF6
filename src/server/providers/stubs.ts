/**
 * Real-provider adapters — ARCHITECTURE ONLY in Phase 1.
 *
 * These descriptors register the providers so the registry, Providers page and
 * recipe validation know about them, but they are `implemented: false`: every
 * call throws PROVIDER_NOT_AVAILABLE. Each will be implemented against the
 * provider's current official documentation once credentials/configuration are
 * available. No behaviour is faked here.
 */
import { hasEnv } from '../config';
import { AppError } from '../errors';
import type { CostEstimate, GenerationProvider, GenerationRequest, PollResult } from './types';

class UnimplementedProvider implements GenerationProvider {
  transport: GenerationProvider['transport'];
  implemented = false;
  models = [];
  constructor(
    public id: string,
    public displayName: string,
    transport: 'api' | 'mcp',
    public capabilities: GenerationProvider['capabilities'],
    public requiredEnv: string[],
    public notes: string,
  ) {
    this.transport = transport;
  }
  configStatus() {
    const missingEnv = this.requiredEnv.filter((k) => !hasEnv(k));
    return { configured: missingEnv.length === 0, missingEnv };
  }
  private unavailable(): never {
    throw new AppError('PROVIDER_NOT_AVAILABLE', `${this.displayName} integration is not implemented yet. It will be built against the official documentation once credentials are configured.`, { retryable: false });
  }
  estimateCost(_req: GenerationRequest): CostEstimate { return this.unavailable(); }
  async submit(): Promise<{ externalId: string }> { return this.unavailable(); }
  async poll(): Promise<PollResult> { return this.unavailable(); }
}

export const STUB_PROVIDERS: GenerationProvider[] = [
  new UnimplementedProvider('google-veo', 'Google Veo', 'api', ['video'], ['GOOGLE_VEO_API_KEY'],
    'Video generation. Adapter will map submit/poll onto the official async API.'),
  new UnimplementedProvider('kling', 'Kling AI', 'api', ['video', 'image'], ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY'],
    'Image/video generation. Adapter will map submit/poll onto the official task API.'),
  new UnimplementedProvider('higgsfield-api', 'Higgsfield API', 'api', ['video', 'image'], ['HIGGSFIELD_API_KEY'],
    'Image/video generation over the official HTTP API.'),
  new UnimplementedProvider('higgsfield-mcp', 'Higgsfield MCP', 'mcp', ['video', 'image', 'tts', 'music'], ['HIGGSFIELD_MCP_URL'],
    'Generation through the official MCP server, driven by an MCP client inside the worker (not browser automation).'),
];
