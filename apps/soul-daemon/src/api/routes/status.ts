/** Authenticated operational status. */

import type { FastifyInstance } from 'fastify';

import type { DaemonApi } from '../daemon-api.js';

export function registerStatusRoute(app: FastifyInstance, api: DaemonApi): void {
  app.get('/v1/status', async (_request, reply) => reply.code(200).send(api.getStatus()));
}
