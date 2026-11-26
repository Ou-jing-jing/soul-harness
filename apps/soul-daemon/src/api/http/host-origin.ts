/** Exact Host/Origin policy for the loopback management API. */

import type { FastifyReply } from 'fastify';

import { ApiError } from '../errors.js';
import { API_HOST, API_PORT, STUDIO_DEV_ORIGIN } from '../wire.js';

export const ALLOWED_HOST = `${API_HOST}:${API_PORT}`;
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  STUDIO_DEV_ORIGIN,
  `http://${API_HOST}:${API_PORT}`,
]);

export function assertHost(host: unknown): void {
  if (typeof host !== 'string' || host !== ALLOWED_HOST) {
    throw new ApiError('forbidden');
  }
}

export function assertOrigin(origin: unknown): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  if (typeof origin !== 'string' || !ALLOWED_ORIGINS.has(origin)) {
    throw new ApiError('forbidden');
  }
  return origin;
}

export function applyCors(reply: FastifyReply, origin: string | undefined): void {
  reply.header('Vary', 'Origin');
  if (origin === undefined) {
    return;
  }
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}
