import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ApiKeyVerifier } from '../../../application/ports/api-key-verifier';
import type { Clock } from '../../../application/ports/clock';
import type { Logger } from '../../../application/ports/logger';
import type { Metrics } from '../../../application/ports/metrics';
import {
  ClientLimitReachedError,
  ServiceUnavailableError,
  UnknownClientError,
} from '../../../domain/errors';
import { readBody } from './body-reader';
import { createHandlers, type HandlerDeps, type Handlers, type Reply } from './handlers';
import {
  ClientAbortedError,
  HttpError,
  invalidJson,
  methodNotAllowed,
  notFound,
  unauthorized,
  unsupportedMediaType,
} from './http-errors';
import { resolveRoute, type Route } from './router';

export interface HttpServerOptions {
  readonly maxBodyBytes: number;
  readonly keepAliveTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxConnections: number;
}

export const DEFAULT_HTTP_OPTIONS: HttpServerOptions = {
  maxBodyBytes: 1024,
  keepAliveTimeoutMs: 5_000,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  maxConnections: 10_000,
};

/** How often Node checks header/request timeouts; its 30 s default would stretch them 2-4x. */
const TIMEOUT_CHECK_INTERVAL_MS = 1_000;

export interface HttpServerDeps extends HandlerDeps {
  readonly verifier: ApiKeyVerifier;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly options?: Partial<HttpServerOptions>;
}

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/** Inbound HTTP adapter: two decision routes plus `/metrics`, on bare `node:http`. */
export function createHttpServer(deps: HttpServerDeps): Server {
  const options = { ...DEFAULT_HTTP_OPTIONS, ...deps.options };
  const handlers = createHandlers(deps);
  const { clock, metrics, logger } = deps;

  async function dispatch(route: Route, req: IncomingMessage, h: Handlers): Promise<Reply> {
    // Authenticate before touching the body, so unauthenticated callers cannot make us read it.
    let actor = '';
    if (route.protected) {
      const verified = deps.verifier.verify(String(req.headers['x-api-key'] ?? ''));
      if (verified === undefined) throw unauthorized();
      actor = verified.keyId;
    }
    if (!route.hasBody) return h.metrics();
    if (!JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '')) throw unsupportedMediaType();
    const raw = await readBody(req, options.maxBodyBytes);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw invalidJson();
    }
    return route.name === 'ratelimit' ? h.ratelimit(body) : h.configure(body, actor);
  }

  function toReply(err: unknown): Reply {
    if (err instanceof HttpError) {
      return {
        status: err.status,
        headers: err.headers,
        body: { error: err.message, ...err.details },
      };
    }
    if (err instanceof UnknownClientError) {
      return { status: 404, body: { error: err.message } };
    }
    if (err instanceof ClientLimitReachedError) {
      return { status: 409, body: { error: err.message } };
    }
    if (err instanceof ServiceUnavailableError) {
      return { status: 503, headers: { 'Retry-After': '1' }, body: { error: err.message } };
    }
    logger.error({ err }, 'fail-closed: unexpected error while handling request');
    return {
      status: 503,
      headers: { 'Retry-After': '1' },
      body: { error: 'internal error; treat the request as denied' },
    };
  }

  function errorClass(err: unknown) {
    if (err instanceof HttpError) return err.errorClass;
    if (err instanceof UnknownClientError) return 'not_found';
    if (err instanceof ClientLimitReachedError) return 'client_limit_reached';
    if (err instanceof ServiceUnavailableError) return 'fail_closed';
    return 'internal';
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = clock.nowMs();
    let label = 'UNMATCHED';
    let reply: Reply;
    try {
      const resolution = resolveRoute(String(req.method), String(req.url));
      if (resolution.kind === 'not_found') throw notFound('route not found');
      if (resolution.kind === 'method_not_allowed') {
        label = 'METHOD_NOT_ALLOWED';
        throw methodNotAllowed(resolution.allow);
      }
      label = resolution.route.label;
      reply = await dispatch(resolution.route, req, handlers);
    } catch (err) {
      if (err instanceof ClientAbortedError) return;
      metrics.recordError(errorClass(err));
      reply = toReply(err);
    }
    const payload = JSON.stringify(reply.body);
    res.writeHead(reply.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...reply.headers,
    });
    res.end(payload);
    metrics.recordRequest(label, reply.status, clock.nowMs() - startedAt);
  }

  const server = createServer(
    {
      keepAliveTimeout: options.keepAliveTimeoutMs,
      headersTimeout: options.headersTimeoutMs,
      requestTimeout: options.requestTimeoutMs,
      connectionsCheckingInterval: TIMEOUT_CHECK_INTERVAL_MS,
    },
    (req, res) => {
      // `handle` maps every failure to a reply itself; this guards only a failure while replying.
      handle(req, res).catch((err: unknown) => {
        logger.error({ err }, 'failed to write response');
        res.destroy();
      });
    },
  );
  server.maxConnections = options.maxConnections;
  return server;
}
