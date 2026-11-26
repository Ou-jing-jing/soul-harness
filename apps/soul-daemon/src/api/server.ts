/**
 * Local management HTTP server.
 *
 * The server receives only the narrow DaemonApi facade and the token verifier.
 * It never receives a Store, a Repository collection, or a Runtime handle.
 * Fastify request logging is disabled: request bodies, headers and tokens are
 * not part of the operational log stream.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { DaemonError } from '../errors.js';
import { ApiError } from './errors.js';
import type { DaemonApi } from './daemon-api.js';
import type { ApiTokenVerifier } from './token.js';
import type { Readiness } from './wire.js';
import { API_BODY_LIMIT_BYTES, API_HOST, API_PORT } from './wire.js';
import { assertBearer } from './http/auth.js';
import { sendHttpError } from './http/errors.js';
import { applyCors, assertHost, assertOrigin } from './http/host-origin.js';
import { TokenBucket } from './http/limits.js';
import { registerEventReadRoutes } from './routes/events-read.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPersonaReadRoutes } from './routes/personas-read.js';
import { registerSessionReadRoutes } from './routes/sessions-read.js';
import { registerStatusRoute } from './routes/status.js';
import { registerTaskReadRoutes } from './routes/tasks-read.js';

export type LocalApiState = 'assembled' | 'running' | 'draining' | 'stopped' | 'failed';

export interface LocalApiServer {
  readonly state: LocalApiState;
  readonly listening: boolean;
  /** Exposed for fastify.inject unit tests; Daemon does not use it. */
  readonly app: FastifyInstance;
  listen(): Promise<void>;
  beginDrain(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalApiServerOptions {
  readonly api: DaemonApi;
  readonly token: ApiTokenVerifier;
  readonly readiness: () => Readiness;
  /** Tests may use 0; production omits this and gets API_PORT. */
  readonly port?: number;
  /** Fake monotonic clock for token-bucket tests. */
  readonly clock?: () => number;
}

interface ServerRuntime {
  readonly app: FastifyInstance;
}

function createApp(options: LocalApiServerOptions, getState: () => LocalApiState): ServerRuntime {
  // `logger: false` keeps Fastify from serializing request bodies or headers.
  const app = Fastify({
    logger: false,
    bodyLimit: API_BODY_LIMIT_BYTES,
    connectionTimeout: 30_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    trustProxy: false,
  });

  const bucket = new TokenBucket({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  app.addHook('onRequest', async (request, reply) => {
    assertHost(request.headers.host);
    const origin = assertOrigin(request.headers.origin);
    applyCors(reply, origin);

    if (!bucket.take()) {
      throw new ApiError('rate_limited');
    }

    if (request.method === 'OPTIONS') {
      return;
    }

    const path = request.url.split('?', 1)[0] ?? '';
    const management = path.startsWith('/v1/') && !path.startsWith('/v1/health/');
    if (management) {
      if (getState() === 'draining') {
        throw new ApiError('unavailable');
      }
      assertBearer(request.headers.authorization, options.token);
    }
  });

  app.setErrorHandler((error, request, reply) => sendHttpError(error, request, reply));

  // Fastify's default 404 object would leak framework text; the method-not-
  // allowed path is normalized to the same fixed not_found envelope.
  app.setNotFoundHandler((_request, reply) => {
    const error = new ApiError('not_found');
    return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  });

  app.options('/*', async (_request, reply) => reply.code(204).send());

  registerHealthRoutes(app, {
    readiness: options.readiness,
    isDraining: () => getState() === 'draining',
  });
  registerStatusRoute(app, options.api);
  registerPersonaReadRoutes(app, options.api);
  registerEventReadRoutes(app, options.api);
  registerTaskReadRoutes(app, options.api);
  registerSessionReadRoutes(app, options.api);

  return { app };
}

export function createLocalApiServer(options: LocalApiServerOptions): LocalApiServer {
  let state: LocalApiState = 'assembled';
  const runtime = createApp(options, () => state);
  const port = options.port ?? API_PORT;
  let started = false;
  let closed = false;

  return Object.freeze({
    get state(): LocalApiState {
      return state;
    },

    app: runtime.app,

    get listening(): boolean {
      return state === 'running' || state === 'draining';
    },

    async listen(): Promise<void> {
      if (started) {
        return;
      }
      try {
        await runtime.app.listen({ host: API_HOST, port });
        started = true;
        state = 'running';
      } catch (error) {
        state = 'failed';
        throw new DaemonError('http_api_start_failed', 'local API failed to listen', {
          cause: error,
        });
      }
    },

    async beginDrain(): Promise<void> {
      if (state === 'running' || state === 'assembled') {
        state = 'draining';
        return;
      }
      if (state === 'draining') {
        return;
      }
      throw new DaemonError('shutdown_failed', 'local API is not in a drainable state');
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      try {
        await runtime.app.close();
        closed = true;
        state = 'stopped';
      } catch (error) {
        state = 'failed';
        throw new DaemonError('shutdown_failed', 'local API failed to close', {
          cause: error,
        });
      }
    },
  });
}
