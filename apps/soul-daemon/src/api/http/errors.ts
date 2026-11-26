/** Fastify error normalization for the local management API. */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { ApiError, apiErrorEnvelope, toApiError } from '../errors.js';

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function normalizeHttpError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  const status = statusOf(error);
  if (status === 413) {
    return new ApiError('too_large', { cause: error });
  }
  if (status === 404 || status === 405) {
    return new ApiError('not_found', { cause: error });
  }
  if (status === 401) {
    return new ApiError('unauthorized', { cause: error });
  }
  if (status === 403) {
    return new ApiError('forbidden', { cause: error });
  }
  if (status === 400) {
    return new ApiError('invalid_request', { cause: error });
  }

  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) {
    return new ApiError('invalid_request', { cause: error });
  }

  return toApiError(error);
}

export function sendHttpError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  void request;
  const mapped = normalizeHttpError(error);
  return reply.code(mapped.status).send(apiErrorEnvelope(mapped));
}

export type HttpError = FastifyError;
