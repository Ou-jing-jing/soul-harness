/**
 * Real SQLite seeds for daemon recovery tests.
 *
 * Rows go through the persistence repositories, with a few deliberate SQL
 * mutations for fail-closed cases. This file is not a production API.
 */

import { join } from 'node:path';

import type {
  AdapterId,
  BootId,
  EventId,
  PersonaId,
  RunId,
  SourceId,
  TaskId,
} from '@soul-harness/contracts';
import {
  createRepositories,
  migrate,
  openStore,
  withWrite,
  type EventRow,
  type PersonaRow,
  type PersonaState,
  type Store,
  type TaskRow,
} from '@soul-harness/persistence';

export const NOW = 1_731_700_000_000;

const OLD_BOOT = 'previous-boot' as BootId;
const ADAPTER = 'qq' as AdapterId;
const SOURCE = 'qq' as SourceId;

function body(n: number): string {
  return `${'0'.repeat(24)}${String(n).padStart(2, '0')}`;
}

export const pid = (n: number): PersonaId => `psn_${body(n)}` as PersonaId;
export const tid = (n: number): TaskId => `tsk_${body(n)}` as TaskId;
export const eid = (n: number): EventId => `evt_${body(n)}` as EventId;
export const rid = (n: number): RunId => `run_${body(n)}` as RunId;

function repos(store: Store) {
  return createRepositories(store);
}

export function prepareDatabase(dir: string, seed: (store: Store) => void): void {
  const store = openStore({ file: join(dir, 'soul.db') });
  try {
    migrate(store);
    seed(store);
  } finally {
    store.close();
  }
}

export function seedPersona(
  store: Store,
  n: number,
  state: PersonaState = 'RUNNING',
  bootId: BootId | null = OLD_BOOT,
): void {
  repos(store).personas.insert({
    id: pid(n),
    displayName: 'SECRET-NAME',
    state,
    bootId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** Inserts one queued task and leaves it unclaimed. */
export function seedQueuedTask(store: Store, n: number, persona = 1): void {
  repos(store).tasks.insertQueuedTask({
    id: tid(n),
    personaId: pid(persona),
    kind: 'thought.run',
    channel: 'inner',
  });
}

/** Inserts one queued task and claims it, so the row is a legal `running` task. */
export function seedRunningTask(store: Store, n: number, persona = 1): void {
  repos(store).tasks.insertQueuedTask({
    id: tid(n),
    personaId: pid(persona),
    kind: 'thought.run',
    channel: 'inner',
  });
  const claimed = repos(store).tasks.claimNext({
    personaId: pid(persona),
    channel: 'inner',
    now: NOW,
    runId: rid(n),
    maxAttempts: 3,
    kinds: ['thought.run'],
  });
  if (claimed === null || claimed.id !== tid(n)) {
    throw new Error(`expected to claim ${tid(n)}`);
  }
}

export function seedEvent(
  store: Store,
  n: number,
  persona: number,
  status: 'received' | 'accepted' | 'noticed',
): void {
  withWrite(store, (tx) => {
    tx.prepare(
      `INSERT INTO events
         (id, persona_id, session_id, source, adapter_id, adapter_event_ref, status,
          attention_outcome, salience, summary, status_reason, received_at, occurred_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, NULL, ?)`,
    ).run(eid(n), pid(persona), SOURCE, ADAPTER, `ref-${n}`, status, NOW, NOW);
  });
}

export function mutate(
  store: Store,
  sql: string,
  ...params: readonly (string | number | null)[]
): void {
  withWrite(store, (tx) => {
    tx.prepare(sql).run(...params);
  });
}

function readOne<T>(dir: string, read: (store: Store) => T): T {
  const store = openStore({ file: join(dir, 'soul.db') });
  try {
    return read(store);
  } finally {
    store.close();
  }
}

export function readPersona(dir: string, n = 1): PersonaRow | null {
  return readOne(dir, (store) => repos(store).personas.getById(pid(n)));
}

export function readTask(dir: string, n = 1, persona = 1): TaskRow | null {
  return readOne(dir, (store) =>
    repos(store).tasks.getById({ personaId: pid(persona), id: tid(n) }),
  );
}

export function readEvent(dir: string, n = 1, persona = 1): EventRow | null {
  return readOne(dir, (store) =>
    repos(store).events.getById({ personaId: pid(persona), id: eid(n) }),
  );
}
