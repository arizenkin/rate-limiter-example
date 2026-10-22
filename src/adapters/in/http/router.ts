export type RouteName = 'ratelimit' | 'configure' | 'metrics';

export interface Route {
  readonly name: RouteName;
  /** Stable, low-cardinality label used for metrics. */
  readonly label: string;
  readonly method: string;
  readonly hasBody: boolean;
  /** Requires a valid admin API key (HLD §6.2). */
  readonly protected: boolean;
}

const ROUTES = new Map<string, Route>([
  [
    '/api/v1/ratelimit',
    {
      name: 'ratelimit',
      label: 'POST /api/v1/ratelimit',
      method: 'POST',
      hasBody: true,
      protected: false,
    },
  ],
  [
    '/api/v1/configure',
    {
      name: 'configure',
      label: 'POST /api/v1/configure',
      method: 'POST',
      hasBody: true,
      protected: true,
    },
  ],
  [
    '/metrics',
    { name: 'metrics', label: 'GET /metrics', method: 'GET', hasBody: false, protected: true },
  ],
]);

export type Resolution =
  | { readonly kind: 'match'; readonly route: Route }
  | { readonly kind: 'method_not_allowed'; readonly allow: string }
  | { readonly kind: 'not_found' };

/** Matches on method + path; the query string is ignored. */
export function resolveRoute(method: string, url: string): Resolution {
  const route = ROUTES.get(url.replace(/[?#].*$/, ''));
  if (route === undefined) return { kind: 'not_found' };
  if (route.method !== method) return { kind: 'method_not_allowed', allow: route.method };
  return { kind: 'match', route };
}
