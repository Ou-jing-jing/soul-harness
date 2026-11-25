import { describe, expect, it } from 'vitest';

import type { EventRow, SessionRow, TaskRow } from '@soul-harness/persistence';
import type { PersonaSnapshot } from '@soul-harness/runtime';

import type { DaemonStatus } from '../src/daemon.js';
import {
  createDaemonApiFacade,
  type DaemonApiFacadeDependencies,
  type EventFacade,
  type PersonaFacade,
  type SessionFacade,
  type TaskFacade,
} from '../src/api/daemon-api.js';

const persona = {
  id: 'persona-1',
  displayName: 'Alice',
  state: 'RUNNING',
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  bootId: 'secret-boot-id',
  epoch: 4,
  runtimeState: 'secret-runtime-state',
} as unknown as PersonaSnapshot;

const event = {
  id: 'event-1',
  personaId: 'persona-1',
  status: 'received',
  statusReason: null,
  receivedAt: 10,
  occurredAt: null,
  archiveState: 'none',
  summary: 'private summary',
  archiveRef: 'private-archive-ref',
} as unknown as EventRow;

const task = {
  id: 'task-1',
  personaId: 'persona-1',
  state: 'queued',
  kind: 'internal',
  channel: 'inner',
  priority: 1,
  attempt: 0,
  scheduledAt: null,
  startedAt: null,
  finishedAt: null,
  payloadJson: 'private payload',
  runId: 'private-run-id',
} as unknown as TaskRow;

const session = {
  id: 'session-1',
  personaId: 'persona-1',
  adapterId: 'adapter-1',
  openedAt: 10,
  closedAt: null,
  externalId: 'private-external-id',
  metaJson: 'private meta',
} as unknown as SessionRow;

function makeDeps(): DaemonApiFacadeDependencies {
  const personas = {
    listPersonas: () => [persona],
    queryPersonas: ({ state }: { state: string }) => (persona.state === state ? [persona] : []),
    getPersona: (id: string) => (id === persona.id ? persona : null),
    createPersona: async () => persona,
    startPersona: async () => persona,
    suspendPersona: async () => persona,
    resumePersona: async () => persona,
    stopPersona: async () => persona,
  } as unknown as PersonaFacade;

  const events = {
    getById: ({ id }: { id: string }) => (id === event.id ? event : null),
    listByPersonaStatus: () => [event],
  } as unknown as EventFacade;

  const tasks = {
    listByPersonaState: () => [task],
  } as unknown as TaskFacade;

  const sessions = {
    listByPersona: () => [session],
  } as unknown as SessionFacade;

  return {
    status: () => ({ phase: 'RUNNING' }) as unknown as DaemonStatus,
    readiness: () => ({ ready: true, reason: null }),
    personas,
    events,
    tasks,
    sessions,
  };
}

describe('DaemonApi facade boundary', () => {
  it('exposes methods only, not dependencies, Store, repositories or Runtime handles', () => {
    const facade = createDaemonApiFacade(makeDeps());
    const keys = Object.keys(facade).sort();

    expect(keys).toStrictEqual(
      [
        'createPersona',
        'getEvent',
        'getPersona',
        'getReadiness',
        'getStatus',
        'listEvents',
        'listPersonas',
        'listSessions',
        'listTasks',
        'resumePersona',
        'startPersona',
        'stopPersona',
        'suspendPersona',
      ].sort(),
    );
    expect(keys).not.toContain('store');
    expect(keys).not.toContain('repositories');
    expect(keys).not.toContain('personas');
    expect(keys).not.toContain('lifecycle');
    expect(Object.isFrozen(facade)).toBe(true);
  });

  it('maps Persona fields without bootId, epoch or runtimeState', () => {
    const facade = createDaemonApiFacade(makeDeps());
    const view = facade.getPersona('persona-1');

    expect(view).toStrictEqual({
      id: 'persona-1',
      displayName: 'Alice',
      state: 'RUNNING',
      version: 3,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(view).not.toHaveProperty('bootId');
    expect(view).not.toHaveProperty('epoch');
    expect(view).not.toHaveProperty('runtimeState');
  });

  it('maps event/task/session metadata without raw content fields', () => {
    const facade = createDaemonApiFacade(makeDeps());
    const eventView = facade.getEvent({ personaId: 'persona-1', eventId: 'event-1' });
    const taskView = facade.listTasks({ personaId: 'persona-1', limit: 1 })[0];
    const sessionView = facade.listSessions({ personaId: 'persona-1', limit: 1 })[0];

    expect(eventView).toStrictEqual({
      id: 'event-1',
      status: 'received',
      statusReason: null,
      receivedAt: 10,
      occurredAt: null,
      archiveState: 'none',
    });
    expect(eventView).not.toHaveProperty('summary');
    expect(eventView).not.toHaveProperty('archiveRef');

    expect(taskView).toStrictEqual({
      id: 'task-1',
      state: 'queued',
      kind: 'internal',
      channel: 'inner',
      priority: 1,
      attempt: 0,
      scheduledAt: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(taskView).not.toHaveProperty('payloadJson');
    expect(taskView).not.toHaveProperty('runId');

    expect(sessionView).toStrictEqual({
      id: 'session-1',
      adapterId: 'adapter-1',
      openedAt: 10,
      closedAt: null,
    });
    expect(sessionView).not.toHaveProperty('externalId');
    expect(sessionView).not.toHaveProperty('metaJson');
  });

  it('delegates Persona writes and returns mapped views', async () => {
    const facade = createDaemonApiFacade(makeDeps());
    await expect(facade.createPersona({ displayName: 'Alice' })).resolves.toMatchObject({
      id: 'persona-1',
      displayName: 'Alice',
    });
    await expect(facade.startPersona('persona-1')).resolves.toMatchObject({ state: 'RUNNING' });
    await expect(facade.suspendPersona('persona-1')).resolves.toMatchObject({ state: 'RUNNING' });
    await expect(facade.resumePersona('persona-1')).resolves.toMatchObject({ state: 'RUNNING' });
    await expect(facade.stopPersona('persona-1')).resolves.toMatchObject({ state: 'RUNNING' });
  });

  it('uses the supplied limit for Persona and metadata lists', () => {
    const facade = createDaemonApiFacade(makeDeps());

    expect(facade.listPersonas({ limit: 1 })).toHaveLength(1);
    expect(facade.listPersonas({ state: 'RUNNING', limit: 1 })).toHaveLength(1);
    expect(facade.listEvents({ personaId: 'persona-1', limit: 1 })).toHaveLength(1);
    expect(facade.listTasks({ personaId: 'persona-1', state: 'queued', limit: 1 })).toHaveLength(1);
    expect(facade.listSessions({ personaId: 'persona-1', limit: 1 })).toHaveLength(1);
  });

  it('delegates status and readiness without exposing internal state', () => {
    const facade = createDaemonApiFacade(makeDeps());
    expect(facade.getStatus()).toStrictEqual({ phase: 'RUNNING' });
    expect(facade.getReadiness()).toStrictEqual({ ready: true, reason: null });
  });
});
