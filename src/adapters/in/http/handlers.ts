import type { CheckRateLimit } from '../../../application/check-rate-limit';
import type { ConfigureLimit } from '../../../application/configure-limit';
import type { GetMetrics } from '../../../application/get-metrics';
import { clientConfigInputSchema, parseInput, rateLimitRequestSchema } from '../schemas';
import { validationError } from './http-errors';

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Handlers {
  ratelimit(body: unknown): Promise<Reply>;
  configure(body: unknown, actor: string): Promise<Reply>;
  metrics(): Reply;
}

export interface HandlerDeps {
  readonly checkRateLimit: CheckRateLimit;
  readonly configureLimit: ConfigureLimit;
  readonly getMetrics: GetMetrics;
}

export function createHandlers(deps: HandlerDeps): Handlers {
  return {
    async ratelimit(body) {
      const parsed = parseInput(rateLimitRequestSchema, body);
      if (!parsed.ok) throw validationError(parsed.failure);
      const decision = await deps.checkRateLimit.execute({
        clientId: parsed.value.client_id,
        resource: parsed.value.resource,
      });
      return {
        status: 200,
        body: decision.allowed
          ? { allowed: true, remaining: decision.remaining }
          : {
              allowed: false,
              remaining: decision.remaining,
              retry_after: decision.retryAfterSeconds,
            },
      };
    },

    async configure(body, actor) {
      const parsed = parseInput(clientConfigInputSchema, body);
      if (!parsed.ok) throw validationError(parsed.failure);
      const config = await deps.configureLimit.execute({
        clientId: parsed.value.client_id,
        windowSeconds: parsed.value.window_seconds,
        requestPerWindow: parsed.value.request_per_window,
        actor,
      });
      return {
        status: 200,
        body: {
          client_id: config.clientId,
          window_seconds: config.windowSeconds,
          request_per_window: config.requestPerWindow,
        },
      };
    },

    metrics() {
      return { status: 200, body: deps.getMetrics.execute() };
    },
  };
}
