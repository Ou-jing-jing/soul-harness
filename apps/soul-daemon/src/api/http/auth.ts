/** Bearer-token verification for management routes. */

import type { ApiTokenVerifier } from '../token.js';
import { ApiError } from '../errors.js';

export function assertBearer(header: unknown, verifier: ApiTokenVerifier): void {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new ApiError('unauthorized');
  }
  const token = header.slice('Bearer '.length);
  if (token.length === 0 || token.includes(' ')) {
    throw new ApiError('unauthorized');
  }
  if (!verifier.verify(token)) {
    throw new ApiError('unauthorized');
  }
}
