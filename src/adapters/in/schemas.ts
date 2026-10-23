import { z } from 'zod';
import { BOUNDS } from '../../domain/config';

/**
 * Input schemas shared by every inbound adapter: both HTTP endpoints and the startup seed file
 * (HLD §11) validate against the same bounds. Schemas are built once at module load.
 */

const ID_LIMITS = { min: 1, max: BOUNDS.idMaxLength } as const;

const FIELD_LIMITS = {
  client_id: ID_LIMITS,
  resource: ID_LIMITS,
  window_seconds: BOUNDS.windowSeconds,
  request_per_window: BOUNDS.requestPerWindow,
} as const;

type SchemaField = keyof typeof FIELD_LIMITS;

const idField = (field: string) => {
  const range = `${field} must be between ${ID_LIMITS.min} and ${ID_LIMITS.max} characters`;
  return z
    .string({
      error: (issue) =>
        issue.input === undefined ? `${field} is required` : `${field} must be a string`,
    })
    .min(ID_LIMITS.min, range)
    .max(ID_LIMITS.max, range);
};

const intField = (field: string, limits: { min: number; max: number }) => {
  const range = `${field} must be between ${limits.min} and ${limits.max}`;
  return z
    .int({
      error: (issue) =>
        issue.input === undefined ? `${field} is required` : `${field} must be an integer`,
    })
    .min(limits.min, range)
    .max(limits.max, range);
};

const objectError = 'request body must be a JSON object';

export const rateLimitRequestSchema = z.object(
  { client_id: idField('client_id'), resource: idField('resource') },
  { error: objectError },
);

export const clientConfigInputSchema = z.object(
  {
    client_id: idField('client_id'),
    window_seconds: intField('window_seconds', BOUNDS.windowSeconds),
    request_per_window: intField('request_per_window', BOUNDS.requestPerWindow),
  },
  { error: objectError },
);

export type RateLimitRequestBody = z.infer<typeof rateLimitRequestSchema>;
export type ClientConfigInput = z.infer<typeof clientConfigInputSchema>;

/** First validation problem: human message, the offending field and (for range errors) bounds. */
export interface ValidationFailure {
  readonly message: string;
  readonly field?: string;
  readonly min?: number;
  readonly max?: number;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ValidationFailure };

export function parseInput<T>(schema: z.ZodType<T>, data: unknown): ParseResult<T> {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  // A failed parse always carries at least one issue.
  const issue = result.error.issues[0] as z.core.$ZodIssue;
  const [field] = issue.path;
  if (field === undefined) return { ok: false, failure: { message: issue.message } };
  const failure: ValidationFailure = { message: issue.message, field: String(field) };
  const isRange = issue.code === 'too_small' || issue.code === 'too_big';
  // Only schema fields can fail (unknown keys are stripped), so the lookup is total.
  return {
    ok: false,
    failure: isRange ? { ...failure, ...FIELD_LIMITS[field as SchemaField] } : failure,
  };
}
