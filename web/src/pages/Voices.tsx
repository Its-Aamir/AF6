import { useQuery } from '@tanstack/react-query';
import { Mic2, Play } from 'lucide-react';
import { Badge, Button, PageHeader, Spinner } from '../components/ui';
import { api, assetUrl } from '../lib/api';
import { useAction, useVoices } from '../lib/hooks';
import type { Asset, Job } from '../lib/types';

export function VoicesPage() {
  const voices = useVoices();
  const jobs = useQuery({ queryKey: ['jobs', 'voice'], queryFn: () => api.get<Job[]>('/jobs?status=active'), refetchInterval: 1500 });
  const previews = useQuery({ queryKey: ['voice-previews'], queryFn: () => api.get<Asset[]>('/voices/previews'), refetchInterval: (jobs.data?.some((j) => j.type === 'voice.preview') ? 1500 : false) });
  const run = useAction((voiceId: string) => api.post(`/voices/${voiceId}/preview`), { success: 'Generating preview…', invalidate: [['jobs', 'voice'], ['voice-previews']] });
  return (
    <div className="mx-auto max-w-[1000px] p-8">
      <PageHeader title="Voices" subtitle="Narration voices available from configured TTS providers. The chosen voice drives the master timeline." />
      {voices.isLoading ? <Spinner /> : (
        <div className="space-y-2">
          {voices.data?.map((v) => {
            const pending = jobs.data?.find((j) => j.type === 'voice.preview' && j.payload.voiceId === v.id);
            const latest = previews.data?.find((a) => a.metadata.voiceId === v.id);
            return (
              <div key={v.id} className="flex items-center gap-4 rounded-xl border border-line bg-panel p-4">
                <div className="grid size-10 place-items-center rounded-full bg-accent/12 text-accent"><Mic2 className="size-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">{v.label}<Badge>{v.providerName}</Badge></div>
                  <div className="text-[12px] text-muted">{v.description} · <code className="text-faint">{v.id}</code></div>
                </div>
                {latest && <audio src={assetUrl(latest.id)} controls className="h-8 w-72" />}
                <Button size="sm" icon={<Play className="size-3.5" />} loading={!!pending} onClick={() => run.mutate(v.id)}>{latest ? 'New preview' : 'Preview'}</Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
