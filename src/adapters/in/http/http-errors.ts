import type { ErrorClass } from '../../../application/ports/metrics';
import type { ValidationFailure } from '../schemas';

/** Protocol-level problems detected by the HTTP adapter itself. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly errorClass: ErrorClass,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Rejections made before the body is read close the connection, so the unread body is not drained. */
const CLOSE = { Connection: 'close' } as const;

export const notFound = (message: string) => new HttpError(404, 'not_found', message, CLOSE);

export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'missing or invalid API key', {
    'WWW-Authenticate': 'ApiKey',
    ...CLOSE,
  });

export const methodNotAllowed = (allow: string) =>
  new HttpError(405, 'method_not_allowed', `method not allowed; use ${allow}`, {
    Allow: allow,
    ...CLOSE,
  });

export const unsupportedMediaType = () =>
  new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json', CLOSE);

export const payloadTooLarge = (maxBytes: number) =>
  new HttpError(413, 'payload_too_large', `request body must not exceed ${maxBytes} bytes`, {
    ...CLOSE,
  });

export const invalidJson = () =>
  new HttpError(400, 'validation', 'request body must be valid JSON');

export const validationError = ({ message, ...details }: ValidationFailure) =>
  new HttpError(400, 'validation', message, {}, details);

/** The client went away before sending a complete body; there is nobody to answer. */
export class ClientAbortedError extends Error {
  constructor() {
    super('client aborted the request');
    this.name = 'ClientAbortedError';
  }
}
