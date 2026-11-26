import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RuntimeError } from '@soul-harness/runtime';

import { loadConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import type { DaemonApi, StatusView } from '../src/api/daemon-api.js';
import { createLocalApiServer, type LocalApiServer } from '../src/api/server.js';
import type { ApiTokenVerifier } from '../src/api/token.js';
import { API_TOKEN_FILE_NAME } from '../src/api/token.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';

const TOKEN = 'p'.repeat(43);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const HOST = { host: '127.0.0.1:18700' };

const persona = {
  id: 'psn_01J00000000000000000000000',
  displayName: 'Alice',
  state: 'CREATED',
  version: 1,
  createdAt: 10,
  updatedAt: 10,
} as const;

const status = {} as StatusView;
const verifier: ApiTokenVerifier = { verify: (candidate) => candidate === TOKEN };

function makeApi(overrides: Partial<DaemonApi> = {}): DaemonApi {
  return {
    getStatus: () => status,
    getReadiness: () => ({ ready: true, reason: null }),
    listPersonas: () => [],
    getPersona: () => null,
    createPersona: async () => persona,
    startPersona: async () => persona,
    suspendPersona: async () => persona,
    resumePersona: async () => persona,
    stopPersona: async () => persona,
    listEvents: () => [],
    getEvent: () => null,
    listTasks: () => [],
    listSessions: () => [],
    ...overrides,
  };
}

const servers: LocalApiServer[] = [];

function makeServer(api: DaemonApi = makeApi()): LocalApiServer {
  const server = createLocalApiServer({
    api,
    token: verifier,
    readiness: () => ({ ready: true, reason: null }),
  });
  servers.push(server);
  return server;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...HOST, ...extra };
}

function createRequest(
  server: LocalApiServer,
  payload: unknown,
  extra: Record<string, string> = {},
) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/personas',
    headers: headers({ ...AUTH, 'content-type': 'application/json', ...extra }),
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

describe('POST /v1/personas validation', () => {
  it('creates a Persona and returns only the PersonaView', async () => {
    const createPersona = vi.fn(async (_input: { readonly displayName: string }) => persona);
    const server = makeServer(makeApi({ createPersona }));
    const response = await createRequest(server, { displayName: 'Alice' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toStrictEqual({ persona });
    expect(createPersona).toHaveBeenCalledWith({ displayName: 'Alice' });
    expect(response.body).not.toContain('bootId');
    expect(response.body).not.toContain('runtimeState');
    expect(response.body).not.toContain('epoch');
  });

  it('accepts displayName boundaries 1 and 128 characters', async () => {
    const createPersona = vi.fn(async (_input: { readonly displayName: string }) => persona);
    const server = makeServer(makeApi({ createPersona }));

    expect((await createRequest(server, { displayName: 'A' })).statusCode).toBe(201);
    expect((await createRequest(server, { displayName: 'a'.repeat(128) })).statusCode).toBe(201);
  });

  it.each([
    ['missing body', undefined],
    ['null body', null],
    ['array body', []],
    ['missing field', {}],
    ['non-string', { displayName: 3 }],
    ['empty', { displayName: '' }],
    ['too long', { displayName: 'a'.repeat(129) }],
    ['leading whitespace', { displayName: ' Alice' }],
    ['trailing whitespace', { displayName: 'Alice ' }],
    ['control NUL', { displayName: 'A\u0000' }],
    ['control DEL', { displayName: 'A\u007f' }],
  ])('rejects %s with fixed invalid_request', async (_name, payload) => {
    const createPersona = vi.fn(async () => persona);
    const server = makeServer(makeApi({ createPersona }));
    const response = await createRequest(server, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    });
    expect(createPersona).not.toHaveBeenCalled();
    expect(response.body).not.toContain('displayName');
    expect(response.body).not.toContain('Alice');
  });

  it('ignores extra internal fields and never passes them to the lifecycle', async () => {
    const createPersona = vi.fn(async (_input: { readonly displayName: string }) => persona);
    const server = makeServer(makeApi({ createPersona }));
    const response = await createRequest(server, {
      displayName: 'Alice',
      id: 'psn_client_chosen',
      state: 'STOPPED',
      version: 99,
      bootId: 'client-boot',
      epoch: 7,
      runtimeState: { state: 'STOPPED' },
    });

    expect(response.statusCode).toBe(201);
    expect(createPersona).toHaveBeenCalledWith({ displayName: 'Alice' });
    expect(JSON.stringify(createPersona.mock.calls)).not.toContain('psn_client_chosen');
    expect(JSON.stringify(createPersona.mock.calls)).not.toContain('client-boot');
  });
});

describe('Persona action routes', () => {
  it('invokes each DaemonApi action and returns 200', async () => {
    const methods = ['start', 'suspend', 'resume', 'stop'] as const;
    for (const method of methods) {
      const fn = vi.fn(async () => persona);
      const server = makeServer(makeApi({ [`${method}Persona`]: fn } as Partial<DaemonApi>));
      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/personas/${persona.id}/${method}`,
        headers: headers(AUTH),
      });
      expect(response.statusCode, method).toBe(200);
      expect(response.json()).toStrictEqual({ persona });
      expect(fn).toHaveBeenCalledWith(persona.id);
    }
  });

  it.each(['not_found', 'illegal_transition', 'version_conflict'] as const)(
    'maps Runtime %s to the fixed error envelope',
    async (code) => {
      const expected = code === 'not_found' ? 404 : 409;
      for (const method of ['start', 'suspend', 'resume', 'stop'] as const) {
        const fn = async () => {
          throw new RuntimeError(code, 'private runtime message');
        };
        const server = makeServer(makeApi({ [`${method}Persona`]: fn } as Partial<DaemonApi>));
        const response = await server.app.inject({
          method: 'POST',
          url: `/v1/personas/${persona.id}/${method}`,
          headers: headers(AUTH),
        });
        expect(response.statusCode, `${method}:${code}`).toBe(expected);
        expect(response.body).not.toContain('private runtime message');
        expect(response.body).not.toContain('RuntimeError');
      }
    },
  );

  it('maps unknown internal failures to a fixed 500 without leaking details', async () => {
    const server = makeServer(
      makeApi({
        startPersona: async () => {
          throw new Error('private path C:\\secret');
        },
      }),
    );
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/personas/${persona.id}/start`,
      headers: headers(AUTH),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toStrictEqual({
      error: { code: 'internal_error', message: 'internal error' },
    });
    expect(response.body).not.toContain('private path');
  });
});

describe('Persona write security', () => {
  const endpoints: readonly { readonly path: string; readonly body?: unknown }[] = [
    { path: '/v1/personas', body: { displayName: 'Alice' } },
    { path: `/v1/personas/${persona.id}/start` },
    { path: `/v1/personas/${persona.id}/suspend` },
    { path: `/v1/personas/${persona.id}/resume` },
    { path: `/v1/personas/${persona.id}/stop` },
  ];

  interface InjectResponse {
    readonly statusCode: number;
    readonly body: string;
    json(): unknown;
  }

  async function postEndpoint(
    server: LocalApiServer,
    endpoint: (typeof endpoints)[number],
    extraHeaders: Record<string, string> = {},
  ): Promise<InjectResponse> {
    const body = endpoint.body;
    const requestHeaders = {
      ...headers({
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      }),
    };
    const base = { method: 'POST' as const, url: endpoint.path, headers: requestHeaders };
    const response =
      body === undefined
        ? await server.app.inject(base)
        : await server.app.inject({ ...base, payload: JSON.stringify(body) as string });
    return response as unknown as InjectResponse;
  }

  it('requires a valid Bearer token for every write endpoint', async () => {
    for (const endpoint of endpoints) {
      const server = makeServer();
      for (const authorization of [undefined, 'Bearer wrong']) {
        const response = await postEndpoint(
          server,
          endpoint,
          authorization === undefined ? {} : { authorization },
        );
        expect(response.statusCode, endpoint.path).toBe(401);
      }
    }
  });

  it('rejects bad Host and Origin for writes', async () => {
    const server = makeServer();
    for (const endpoint of endpoints) {
      const badHost = await postEndpoint(server, endpoint, {
        ...AUTH,
        host: 'evil.example',
      });
      expect(badHost.statusCode).toBe(403);

      const badOrigin = await postEndpoint(server, endpoint, {
        ...AUTH,
        origin: 'https://evil.example',
      });
      expect(badOrigin.statusCode).toBe(403);
    }
  });

  it('returns 503 while draining without invoking PersonaLifecycle', async () => {
    const createPersona = vi.fn(async () => persona);
    const startPersona = vi.fn(async () => persona);
    const suspendPersona = vi.fn(async () => persona);
    const resumePersona = vi.fn(async () => persona);
    const stopPersona = vi.fn(async () => persona);
    const server = makeServer(
      makeApi({
        createPersona,
        startPersona,
        suspendPersona,
        resumePersona,
        stopPersona,
      }),
    );
    await server.beginDrain();

    for (const endpoint of endpoints) {
      const response = await postEndpoint(server, endpoint, AUTH);
      expect(response.statusCode, endpoint.path).toBe(503);
      expect(response.json()).toStrictEqual({
        error: { code: 'unavailable', message: 'service unavailable' },
      });
    }
    for (const fn of [createPersona, startPersona, suspendPersona, resumePersona, stopPersona]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed JSON and body over 64 KiB before a write', async () => {
    const createPersona = vi.fn(async () => persona);
    const server = makeServer(makeApi({ createPersona }));

    const malformed = await server.app.inject({
      method: 'POST',
      url: '/v1/personas',
      headers: headers({ ...AUTH, 'content-type': 'application/json' }),
      payload: '{"displayName":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toStrictEqual({
      error: { code: 'invalid_request', message: 'invalid request' },
    });

    const tooLarge = await server.app.inject({
      method: 'POST',
      url: '/v1/personas',
      headers: headers({ ...AUTH, 'content-type': 'application/json' }),
      payload: JSON.stringify({ displayName: 'x'.repeat(65 * 1024) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(createPersona).not.toHaveBeenCalled();
  });

  it('consumes the same token bucket as read routes', async () => {
    const createPersona = vi.fn(async () => persona);
    const server = makeServer(makeApi({ createPersona }));
    // The default bucket is fresh for this server; health requests consume it.
    for (let index = 0; index < 20; index += 1) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/health/live',
        headers: HOST,
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await createRequest(server, { displayName: 'Alice' });
    expect(limited.statusCode).toBe(429);
    expect(createPersona).not.toHaveBeenCalled();
  });
});

describe('Persona write integration with real Daemon', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      removeTempDir(dirs.pop() as string);
    }
  });

  function tempDir(): string {
    const dir = makeTempDir('sh-api-personas-');
    dirs.push(dir);
    return dir;
  }

  it('creates and transitions a Persona through the real lifecycle and persists it', async () => {
    const dir = tempDir();
    const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
    const { logger } = createRecordingLogger();
    const daemon = new SoulDaemon({ config, logger });
    await daemon.start();
    const token = readFileSync(join(dir, API_TOKEN_FILE_NAME), 'utf8').replace(/\r?\n$/u, '');
    const auth = { authorization: `Bearer ${token}` };

    const post = async (path: string, payload?: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:18700${path}`, {
        method: 'POST',
        headers: {
          ...auth,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });

    const created = await post('/v1/personas', { displayName: 'Alice' });
    expect(created.status).toBe(201);
    const createdView = (await created.json()) as { persona: { id: string; state: string } };
    const personaId = createdView.persona.id;
    expect(createdView.persona.state).toBe('CREATED');

    const listed = await fetch('http://127.0.0.1:18700/v1/personas', { headers: auth });
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown).toMatchObject({
      personas: [expect.objectContaining({ id: personaId, displayName: 'Alice' })],
    });

    const started = await post(`/v1/personas/${personaId}/start`);
    expect(started.status).toBe(200);
    expect(((await started.json()) as { persona: { state: string } }).persona.state).toBe(
      'RUNNING',
    );

    const suspended = await post(`/v1/personas/${personaId}/suspend`);
    expect(suspended.status).toBe(200);
    expect(((await suspended.json()) as { persona: { state: string } }).persona.state).toBe(
      'SUSPENDED',
    );

    const resumed = await post(`/v1/personas/${personaId}/resume`);
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { persona: { state: string } }).persona.state).toBe(
      'RUNNING',
    );

    const stopped = await post(`/v1/personas/${personaId}/stop`);
    expect(stopped.status).toBe(200);
    expect(((await stopped.json()) as { persona: { state: string } }).persona.state).toBe(
      'STOPPED',
    );

    const stoppedAgain = await post(`/v1/personas/${personaId}/stop`);
    expect(stoppedAgain.status).toBe(200);
    expect(((await stoppedAgain.json()) as { persona: { state: string } }).persona.state).toBe(
      'STOPPED',
    );

    const invalid = await post(`/v1/personas/${personaId}/suspend`);
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toStrictEqual({
      error: { code: 'conflict', message: 'state conflict' },
    });

    await daemon.stop('api-personas');
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  }, 15_000);
});
