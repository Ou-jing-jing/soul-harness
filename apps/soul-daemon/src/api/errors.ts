/**
 * Daemon-local management API error protocol.
 *
 * This is intentionally not `soul.error.v1`: SH-009's frozen decision keeps the
 * Contracts package unchanged. The envelope contains only a controlled code and
 * its fixed, canonical message; exception text, stacks, paths, request bodies
 * and tokens are never copied into it.
 */

import { isRuntimeError } from '@soul-harness/runtime';

export const API_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'too_large',
  'rate_limited',
  'unavailable',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  unavailable: 503,
  internal_error: 500,
});

export const API_ERROR_MESSAGES: Readonly<Record<ApiErrorCode, string>> = Object.freeze({
  invalid_request: 'invalid request',
  unauthorized: 'authentication required',
  forbidden: 'request forbidden',
  not_found: 'resource not found',
  conflict: 'state conflict',
  too_large: 'request body too large',
  rate_limited: 'too many requests',
  unavailable: 'service unavailable',
  internal_error: 'internal error',
});

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, options?: { readonly cause?: unknown }) {
    super(
      API_ERROR_MESSAGES[code],
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
  }
}

/** Converts known Runtime failures to the local API vocabulary. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (isRuntimeError(error)) {
    switch (error.code) {
      case 'invalid_argument':
      case 'schema_invalid':
        return new ApiError('invalid_request', { cause: error });
      case 'not_found':
        return new ApiError('not_found', { cause: error });
      case 'illegal_transition':
      case 'version_conflict':
        return new ApiError('conflict', { cause: error });
      case 'closed':
        return new ApiError('unavailable', { cause: error });
      default:
        return new ApiError('internal_error', { cause: error });
    }
  }
  return new ApiError('internal_error', { cause: error });
}

/** The only shape an API error response may return. */
export function apiErrorEnvelope(error: ApiError): ApiErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: API_ERROR_MESSAGES[error.code],
    },
  };
}
