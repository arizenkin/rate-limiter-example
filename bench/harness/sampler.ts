import type { MemorySample } from '../lib/memory';
import type { ServerMetrics } from '../lib/metrics-diff';

/** Reads GET /metrics; undefined when the target does not expose it. */
export async function fetchMetrics(
  baseUrl: string,
  apiKey: string,
): Promise<ServerMetrics | undefined> {
  try {
    const res = await fetch(`${baseUrl}/metrics`, { headers: { 'x-api-key': apiKey } });
    return res.ok ? ((await res.json()) as ServerMetrics) : undefined;
  } catch {
    return undefined;
  }
}

export interface MemorySampler {
  stop(): MemorySample[];
}

/** Samples the server's own RSS/heap (reported by /metrics) once per second. */
export function startMemorySampler(baseUrl: string, apiKey: string): MemorySampler {
  const startedAt = Date.now();
  const samples: MemorySample[] = [];
  const take = async () => {
    const metrics = await fetchMetrics(baseUrl, apiKey);
    if (metrics !== undefined) {
      samples.push({
        tSec: Math.round((Date.now() - startedAt) / 100) / 10,
        rssBytes: metrics.process.rssBytes,
        heapUsedBytes: metrics.process.heapUsedBytes,
      });
    }
  };
  void take();
  const timer = setInterval(() => void take(), 1000);
  return {
    stop() {
      clearInterval(timer);
      return samples;
    },
  };
}
