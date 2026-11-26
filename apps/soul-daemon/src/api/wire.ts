/**
 * Local management API wire surface.
 *
 * SH-009 deliberately does not add these types to `packages/contracts`; the
 * frozen plan keeps Contracts untouched and uses a Daemon-local error/wire
 * vocabulary for the local management API. IDs are represented as strings at
 * this boundary; the Runtime validates branded IDs before use.
 */

import type {
  EventRow,
  PersonaState,
  SessionRow,
  TaskRow,
  TaskState,
} from '@soul-harness/persistence';

export const API_HOST = '127.0.0.1';
export const API_PORT = 18_700;
export const STUDIO_DEV_ORIGIN = 'http://127.0.0.1:18701';
export const API_PATH_PREFIX = '/v1';
export const API_PROTOCOL = 'soul.ws.v1';
export const API_BODY_LIMIT_BYTES = 64 * 1024;
export const API_DEFAULT_LIST_LIMIT = 50;
export const API_MAX_LIST_LIMIT = 200;

export const EVENT_STATUS_VALUES: readonly EventRow['status'][] = [
  'received',
  'accepted',
  'noticed',
  'understood',
  'response_committed',
  'acted',
  'rejected',
  'expired',
];

export type PersonaId = string;
export type EventId = string;
export type TaskId = string;
export type SessionId = string;

export type ReadyReason =
  | 'phase_not_running'
  | 'store_unavailable'
  | 'lock_not_held'
  | 'recovery_incomplete'
  | 'draining'
  | 'api_not_listening';

export interface Readiness {
  readonly ready: boolean;
  readonly reason: ReadyReason | null;
}

export interface PersonaView {
  readonly id: PersonaId;
  readonly displayName: string;
  readonly state: PersonaState;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EventView {
  readonly id: EventId;
  readonly status: EventRow['status'];
  readonly statusReason: EventRow['statusReason'];
  readonly receivedAt: number;
  readonly occurredAt: number | null;
  readonly archiveState: EventRow['archiveState'];
}

export interface TaskView {
  readonly id: TaskId;
  readonly state: TaskState;
  readonly kind: string;
  readonly channel: TaskRow['channel'];
  readonly priority: number;
  readonly attempt: number;
  readonly scheduledAt: number | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface SessionView {
  readonly id: SessionId;
  readonly adapterId: SessionRow['adapterId'];
  readonly openedAt: number;
  readonly closedAt: number | null;
}
