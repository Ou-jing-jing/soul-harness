/** Anonymous, minimal liveness/readiness routes. */

import type { FastifyInstance } from 'fastify';

import type { Readiness } from '../wire.js';

export interface HealthRouteDeps {
  readonly readiness: () => Readiness;
  readonly isDraining: () => boolean;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRouteDeps): void {
  app.get('/v1/health/live', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  app.get('/v1/health/ready', async (_request, reply) => {
    if (deps.isDraining()) {
      return reply.code(503).send({ status: 'not_ready', reason: 'draining' });
    }
    const readiness = deps.readiness();
    if (readiness.ready) {
      return reply.code(200).send({ status: 'ready' });
    }
    return reply.code(503).send({
      status: 'not_ready',
      reason: readiness.reason ?? 'phase_not_running',
    });
  });
}
