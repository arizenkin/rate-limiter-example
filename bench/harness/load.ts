import autocannon from 'autocannon';
import type { BenchOptions } from '../lib/options';
import type { ClientStats } from '../lib/report';
import {
  buildHeaders,
  CONFIGURE_PATH,
  pickRequest,
  type ClientConfigBody,
  type RequestPlan,
} from '../lib/requests';

export async function seedClients(
  url: string,
  apiKey: string,
  bodies: readonly ClientConfigBody[],
): Promise<void> {
  for (const body of bodies) {
    const res = await fetch(`${url}/api/v1/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const hint = res.status === 401 ? ' (is the admin API key correct?)' : '';
      throw new Error(`seeding ${body.client_id} failed: HTTP ${res.status}${hint}`);
    }
  }
}

/** Runs autocannon with a fixed request cycle, one request in flight per connection. */
export async function runLoad(
  url: string,
  options: BenchOptions,
  apiKey: string,
  durationSec: number,
  plan: RequestPlan,
): Promise<ClientStats> {
  const headers = buildHeaders(apiKey);
  const result = await autocannon({
    url,
    connections: options.connections,
    duration: durationSec,
    pipelining: 1,
    ...(options.rate !== undefined && { overallRate: options.rate }),
    requests: [
      {
        method: 'POST',
        headers: headers.ratelimit,
        // Runs for every request: pick a random client / endpoint (see pickRequest).
        setupRequest: (request) => {
          const picked = pickRequest(plan, Math.random);
          request.headers = picked.path === CONFIGURE_PATH ? headers.configure : headers.ratelimit;
          return Object.assign(request, picked);
        },
      },
    ],
  });
  return {
    totalRequests: result.requests.total,
    durationSec: result.duration,
    requestsPerSec: {
      avg: result.requests.average,
      min: result.requests.min,
      max: result.requests.max,
    },
    latencyMs: {
      avg: result.latency.average,
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      p99_9: result.latency.p99_9,
      max: result.latency.max,
    },
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
  };
}
