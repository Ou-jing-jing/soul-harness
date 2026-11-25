import { describe, expect, it } from 'vitest';

import { RuntimeError } from '@soul-harness/runtime';

import {
  API_ERROR_CODES,
  API_ERROR_MESSAGES,
  API_ERROR_STATUS,
  ApiError,
  apiErrorEnvelope,
  toApiError,
} from '../src/api/errors.js';

describe('daemon local API errors', () => {
  it('has a fixed status and canonical message for every code', () => {
    expect(API_ERROR_CODES).toStrictEqual([
      'invalid_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'too_large',
      'rate_limited',
      'unavailable',
      'internal_error',
    ]);
    expect(API_ERROR_STATUS).toStrictEqual({
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
    expect(API_ERROR_MESSAGES).toStrictEqual({
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
  });

  it('never serializes cause, details, stack or free text', () => {
    const secret = 'token=secret-value path=/tmp/private body=hello';
    const error = new ApiError('invalid_request', { cause: new Error(secret) });
    const envelope = apiErrorEnvelope(error);

    expect(envelope).toStrictEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(error.message).toBe('invalid request');
    expect(error.status).toBe(400);
  });

  it('maps Runtime failures without copying their messages', () => {
    expect(toApiError(new RuntimeError('invalid_argument', 'secret detail')).code).toBe(
      'invalid_request',
    );
    expect(toApiError(new RuntimeError('schema_invalid', 'secret detail')).code).toBe(
      'invalid_request',
    );
    expect(toApiError(new RuntimeError('not_found', 'secret detail')).code).toBe('not_found');
    expect(toApiError(new RuntimeError('illegal_transition', 'secret detail')).code).toBe(
      'conflict',
    );
    expect(toApiError(new RuntimeError('version_conflict', 'secret detail')).code).toBe('conflict');
    expect(toApiError(new RuntimeError('closed', 'secret detail')).code).toBe('unavailable');
    expect(toApiError(new RuntimeError('invalid_clock', 'secret detail')).code).toBe(
      'internal_error',
    );
  });

  it('treats an already mapped ApiError as authoritative', () => {
    const original = new ApiError('forbidden');
    expect(toApiError(original)).toBe(original);
  });

  it('maps unknown values to internal_error', () => {
    const mapped = toApiError(new Error('private path /tmp/x'));
    expect(mapped.code).toBe('internal_error');
    expect(apiErrorEnvelope(mapped)).toStrictEqual({
      error: { code: 'internal_error', message: 'internal error' },
    });
  });
});
