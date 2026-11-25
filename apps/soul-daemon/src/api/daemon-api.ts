/**
 * Narrow facade between the future API server and the Daemon.
 *
 * The facade exposes no Store, database handle, Repository collection or
 * Runtime object. The API server will receive only this interface plus the
 * token verifier; all mapping to persistence/runtime happens inside the Daemon
 * composition and never in a route.
 */

import {
  TASK_STATES,
  type EventRepository,
  type EventRow,
  type PersonaState,
  type SessionRepository,
  type SessionRow,
  type TaskRepository,
  type TaskRow,
  type TaskState,
} from '@soul-harness/persistence';
import type { PersonaLifecycle, PersonaSnapshot } from '@soul-harness/runtime';

import type { DaemonStatus } from '../daemon.js';
import type {
  EventId,
  EventView,
  PersonaId,
  PersonaView,
  Readiness,
  SessionView,
  TaskView,
} from './wire.js';

export type PersonaFacade = Pick<
  PersonaLifecycle,
  | 'listPersonas'
  | 'queryPersonas'
  | 'getPersona'
  | 'createPersona'
  | 'startPersona'
  | 'suspendPersona'
  | 'resumePersona'
  | 'stopPersona'
>;

export type EventFacade = Pick<EventRepository, 'getById' | 'listByPersonaStatus'>;
export type TaskFacade = Pick<TaskRepository, 'listByPersonaState'>;
export type SessionFacade = Pick<SessionRepository, 'listByPersona'>;

export interface DaemonApiFacadeDependencies {
  readonly status: () => DaemonStatus;
  readonly readiness: () => Readiness;
  readonly personas: PersonaFacade;
  readonly events: EventFacade;
  readonly tasks: TaskFacade;
  readonly sessions: SessionFacade;
}

export interface DaemonApi {
  getStatus(): DaemonStatus;
  getReadiness(): Readiness;
  listPersonas(query: {
    readonly state?: PersonaState;
    readonly limit: number;
  }): readonly PersonaView[];
  getPersona(id: PersonaId): PersonaView | null;
  createPersona(input: { readonly displayName: string }): Promise<PersonaView>;
  startPersona(id: PersonaId): Promise<PersonaView>;
  suspendPersona(id: PersonaId): Promise<PersonaView>;
  resumePersona(id: PersonaId): Promise<PersonaView>;
  stopPersona(id: PersonaId): Promise<PersonaView>;
  listEvents(input: {
    readonly personaId: PersonaId;
    readonly status?: EventRow['status'];
    readonly limit: number;
  }): readonly EventView[];
  getEvent(input: { readonly personaId: PersonaId; readonly eventId: EventId }): EventView | null;
  listTasks(input: {
    readonly personaId: PersonaId;
    readonly state?: TaskState;
    readonly limit: number;
  }): readonly TaskView[];
  listSessions(input: {
    readonly personaId: PersonaId;
    readonly limit: number;
  }): readonly SessionView[];
}

type RuntimePersonaId = Parameters<PersonaLifecycle['getPersona']>[0];
type RepositoryPersonaId = Parameters<EventRepository['getById']>[0]['personaId'];

const EVENT_STATUS_VALUES: readonly EventRow['status'][] = [
  'received',
  'accepted',
  'noticed',
  'understood',
  'response_committed',
  'acted',
  'rejected',
  'expired',
];

function toPersonaView(persona: PersonaSnapshot): PersonaView {
  return {
    id: persona.id,
    displayName: persona.displayName,
    state: persona.state,
    version: persona.version,
    createdAt: persona.createdAt,
    updatedAt: persona.updatedAt,
  };
}

function toEventView(event: EventRow): EventView {
  return {
    id: event.id,
    status: event.status,
    statusReason: event.statusReason,
    receivedAt: event.receivedAt,
    occurredAt: event.occurredAt,
    archiveState: event.archiveState,
  };
}

function toTaskView(task: TaskRow): TaskView {
  return {
    id: task.id,
    state: task.state,
    kind: task.kind,
    channel: task.channel,
    priority: task.priority,
    attempt: task.attempt,
    scheduledAt: task.scheduledAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

function toSessionView(session: SessionRow): SessionView {
  return {
    id: session.id,
    adapterId: session.adapterId,
    openedAt: session.openedAt,
    closedAt: session.closedAt,
  };
}

function asRuntimePersonaId(id: PersonaId): RuntimePersonaId {
  return id as RuntimePersonaId;
}

function asRepositoryPersonaId(id: PersonaId): RepositoryPersonaId {
  return id as RepositoryPersonaId;
}

function sortByEventOrder(a: EventRow, b: EventRow): number {
  return b.receivedAt - a.receivedAt || a.id.localeCompare(b.id);
}

function sortByTaskId(a: TaskRow, b: TaskRow): number {
  return a.id.localeCompare(b.id);
}

/**
 * Builds the only object the API server is allowed to see. The dependency
 * object itself is not retained as a public property of the returned facade.
 */
export function createDaemonApiFacade(deps: DaemonApiFacadeDependencies): DaemonApi {
  return Object.freeze({
    getStatus: (): DaemonStatus => deps.status(),
    getReadiness: (): Readiness => deps.readiness(),

    listPersonas: (query: {
      readonly state?: PersonaState;
      readonly limit: number;
    }): readonly PersonaView[] =>
      (query.state === undefined
        ? deps.personas.listPersonas()
        : deps.personas.queryPersonas({ state: query.state })
      )
        .slice(0, query.limit)
        .map(toPersonaView),

    getPersona: (id: PersonaId): PersonaView | null => {
      const persona = deps.personas.getPersona(asRuntimePersonaId(id));
      return persona === null ? null : toPersonaView(persona);
    },

    createPersona: async (input: { readonly displayName: string }): Promise<PersonaView> =>
      toPersonaView(await deps.personas.createPersona({ displayName: input.displayName })),
    startPersona: async (id: PersonaId): Promise<PersonaView> =>
      toPersonaView(await deps.personas.startPersona(asRuntimePersonaId(id))),
    suspendPersona: async (id: PersonaId): Promise<PersonaView> =>
      toPersonaView(await deps.personas.suspendPersona(asRuntimePersonaId(id))),
    resumePersona: async (id: PersonaId): Promise<PersonaView> =>
      toPersonaView(await deps.personas.resumePersona(asRuntimePersonaId(id))),
    stopPersona: async (id: PersonaId): Promise<PersonaView> =>
      toPersonaView(await deps.personas.stopPersona(asRuntimePersonaId(id))),

    listEvents: (input: {
      readonly personaId: PersonaId;
      readonly status?: EventRow['status'];
      readonly limit: number;
    }): readonly EventView[] => {
      const personaId = asRepositoryPersonaId(input.personaId);
      const rows =
        input.status === undefined
          ? EVENT_STATUS_VALUES.flatMap((status) =>
              deps.events.listByPersonaStatus({
                personaId,
                status,
                limit: input.limit,
              }),
            )
          : deps.events.listByPersonaStatus({
              personaId,
              status: input.status,
              limit: input.limit,
            });
      return [...rows].sort(sortByEventOrder).slice(0, input.limit).map(toEventView);
    },

    getEvent: (input: {
      readonly personaId: PersonaId;
      readonly eventId: EventId;
    }): EventView | null => {
      const event = deps.events.getById({
        personaId: asRepositoryPersonaId(input.personaId),
        id: input.eventId as Parameters<EventRepository['getById']>[0]['id'],
      });
      return event === null ? null : toEventView(event);
    },

    listTasks: (input: {
      readonly personaId: PersonaId;
      readonly state?: TaskState;
      readonly limit: number;
    }): readonly TaskView[] => {
      const personaId = asRepositoryPersonaId(input.personaId);
      const states: readonly TaskState[] = input.state === undefined ? TASK_STATES : [input.state];
      return states
        .flatMap((state) =>
          deps.tasks.listByPersonaState({
            personaId,
            state,
            limit: input.limit,
          }),
        )
        .sort(sortByTaskId)
        .slice(0, input.limit)
        .map(toTaskView);
    },

    listSessions: (input: {
      readonly personaId: PersonaId;
      readonly limit: number;
    }): readonly SessionView[] =>
      deps.sessions
        .listByPersona(asRepositoryPersonaId(input.personaId), input.limit)
        .slice(0, input.limit)
        .map(toSessionView),
  });
}
