import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openStore } from '@soul-harness/persistence';

import { loadConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { isDaemonError, type DaemonError } from '../src/errors.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import type { LogRecord } from './helpers/harness.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';
import {
  NOW,
  eid,
  mutate,
  prepareDatabase,
  readEvent,
  readPersona,
  readTask,
  rid,
  seedEvent,
  seedPersona,
  seedRunningTask,
  tid,
} from './helpers/recovery-seed.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-recover-');
  dirs.push(dir);
  return dir;
}

function fixedClock(): Date {
  return new Date(NOW);
}

function boot(
  dir: string,
  env: Record<string, string> = {},
  clock: () => Date = fixedClock,
): { daemon: SoulDaemon; records: LogRecord[] } {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV, ...env });
  const { logger, records } = createRecordingLogger();
  return { daemon: new SoulDaemon({ config, logger, clock }), records };
}

async function startFailure(
  dir: string,
  env: Record<string, string> = {},
  clock: () => Date = fixedClock,
): Promise<{ caught: unknown; records: LogRecord[] }> {
  const started = boot(dir, env, clock);
  let caught: unknown;
  try {
    await started.daemon.start();
  } catch (error) {
    caught = error;
  }
  return { caught, records: started.records };
}

function incomplete(caught: unknown): DaemonError {
  expect(isDaemonError(caught)).toBe(true);
  if (!isDaemonError(caught)) {
    throw new Error('expected a daemon error');
  }
  expect(caught.code).toBe('recovery_incomplete');
  expect(caught.message).toBe('runtime recovery did not finish');
  return caught;
}

function reasonOf(records: LogRecord[]): {
  reason: string;
  tasksRequeued: number;
  eventsExpired: number;
} {
  const record = records.find((entry) => entry['event'] === 'recovery_incomplete');
  expect(record).toBeDefined();
  return {
    reason: String(record?.['reason']),
    tasksRequeued: Number(record?.['tasksRequeued']),
    eventsExpired: Number(record?.['eventsExpired']),
  };
}

function assertClosed(dir: string, records: LogRecord[]): void {
  const phases = records
    .filter((record) => record['event'] === 'phase_entered')
    .map((record) => record['phase']);
  expect(phases).not.toContain('READY');
  expect(phases).not.toContain('RUNNING');
  expect(records.some((record) => record['event'] === 'scheduler_started')).toBe(false);
  expect(
    records.some((record) => record['step'] === 'scheduler' && record['event'] === 'step_ok'),
  ).toBe(false);
  expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  expect(JSON.stringify(records)).not.toContain('SECRET-NAME');
}

describe('RECOVERING assembly', () => {
  it('recovers an empty database and starts a scheduler that does not dispatch', async () => {
    const dir = tempDir();
    const { daemon, records } = boot(dir);
    const report = await daemon.start();

    expect(report.recovery).toEqual({
      personasNormalized: 0,
      personasScanned: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      eventsExpired: 0,
    });
    expect(report.components.scheduler).toEqual({
      assembled: true,
      started: true,
      state: 'running',
      handlerKinds: 0,
      dispatchesTasks: false,
    });
    expect(report.components.eventBus.acceptsInput).toBe(false);
    expect(report.components.eventBus.transport).toBe('none');
    expect(report.components.personaLifecycle.autoStarted).toBe(false);
    expect(daemon.status.bootId).toBe(report.bootId);

    await daemon.stop('done');

    const second = boot(dir);
    const again = await second.daemon.start();
    expect(again.recovery).toEqual(report.recovery);
    await second.daemon.stop('done');
    expect(records.some((record) => record['event'] === 'scheduler_started')).toBe(true);
  });

  it('normalizes crashed personas, converges tasks and events, and does not start personas', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1, 'STARTING');
      seedPersona(store, 2, 'STOPPING');
      seedPersona(store, 3, 'RUNNING');
      seedPersona(store, 4, 'FAILED');
      seedRunningTask(store, 1, 3);
      seedRunningTask(store, 2, 3);
      mutate(store, 'UPDATE tasks SET attempt = 3 WHERE id = ?', tid(2));
      seedEvent(store, 1, 3, 'received');
      seedEvent(store, 2, 3, 'accepted');
    });
    const beforeRun = readTask(dir, 1, 3)?.runId;
    const cappedRun = readTask(dir, 2, 3)?.runId;

    const { daemon, records } = boot(dir);
    const report = await daemon.start();

    expect(report.recovery).toEqual({
      personasNormalized: 2,
      personasScanned: 4,
      tasksRequeued: 1,
      tasksFailed: 1,
      eventsExpired: 2,
    });
    expect(readPersona(dir, 1)?.state).toBe('STOPPED');
    expect(readPersona(dir, 2)?.state).toBe('STOPPED');
    expect(readPersona(dir, 3)?.state).toBe('RUNNING');
    expect(readPersona(dir, 4)?.state).toBe('FAILED');
    expect(readTask(dir, 1, 3)).toMatchObject({ state: 'queued', attempt: 1, runId: beforeRun });
    expect(readTask(dir, 2, 3)).toMatchObject({ state: 'failed', attempt: 3, runId: cappedRun });
    expect(readEvent(dir, 1, 3)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
    expect(readEvent(dir, 2, 3)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
    expect(report.components.scheduler.assembled).toBe(true);
    expect(report.components.scheduler.dispatchesTasks).toBe(false);
    expect(JSON.stringify(records)).not.toContain('SECRET-NAME');

    await daemon.stop('done');

    const eventUpdated = readEvent(dir, 1, 3)?.updatedAt;
    const again = boot(dir);
    const second = await again.daemon.start();
    expect(second.recovery).toEqual({
      personasNormalized: 0,
      personasScanned: 4,
      tasksRequeued: 0,
      tasksFailed: 0,
      eventsExpired: 0,
    });
    expect(readTask(dir, 1, 3)).toMatchObject({ state: 'queued', attempt: 1, runId: beforeRun });
    expect(readEvent(dir, 1, 3)?.updatedAt).toBe(eventUpdated);
    await again.daemon.stop('done');
  });

  it('maps a throwing clock during normalize to persona_recovery_failed', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1, 'STARTING');
    });

    const { caught, records } = await startFailure(dir, {}, () => {
      throw new Error('secret boom');
    });

    expect(isDaemonError(caught) && caught.code).toBe('persona_recovery_failed');
    expect(isDaemonError(caught) && caught.message).toBe('persona recovery failed');
    expect(isDaemonError(caught) && caught.details).toBeUndefined();
    expect(readPersona(dir, 1)?.state).toBe('STARTING');
    assertClosed(dir, records);
    expect(JSON.stringify(records)).not.toContain('secret boom');
  });

  it('maps a throwing clock during runtime recovery to runtime_recovery_failed', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1, 'RUNNING');
      seedRunningTask(store, 1);
    });
    const before = readTask(dir, 1);

    const { caught, records } = await startFailure(dir, {}, () => {
      throw new Error('secret boom');
    });

    expect(isDaemonError(caught) && caught.code).toBe('runtime_recovery_failed');
    expect(isDaemonError(caught) && caught.details).toBeUndefined();
    expect(readTask(dir, 1)).toMatchObject({
      state: 'running',
      attempt: before?.attempt,
      runId: before?.runId,
    });
    assertClosed(dir, records);
    expect(JSON.stringify(records)).not.toContain('secret boom');
  });
});

describe('row budget and restart', () => {
  function seedPair(dir: string): void {
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedRunningTask(store, 1);
      seedRunningTask(store, 2);
    });
  }

  it('maxRows=1 writes nothing and a later full budget converges both once', async () => {
    const dir = tempDir();
    seedPair(dir);
    const firstBefore = readTask(dir, 1);
    const secondBefore = readTask(dir, 2);

    const zero = await startFailure(dir, { SOUL_RECOVERY_MAX_ROWS: '1' });
    expect(incomplete(zero.caught).details).toEqual({ reason: 'row_budget_exceeded' });
    expect(reasonOf(zero.records)).toMatchObject({
      reason: 'row_budget_exceeded',
      tasksRequeued: 0,
    });
    expect(readTask(dir, 1)).toMatchObject({
      state: 'running',
      attempt: 1,
      runId: firstBefore?.runId,
    });
    expect(readTask(dir, 2)).toMatchObject({
      state: 'running',
      attempt: 1,
      runId: secondBefore?.runId,
    });
    assertClosed(dir, zero.records);

    const again = await startFailure(dir, { SOUL_RECOVERY_MAX_ROWS: '1' });
    expect(incomplete(again.caught).details).toEqual({ reason: 'row_budget_exceeded' });
    expect(readTask(dir, 1)?.state).toBe('running');
    expect(readTask(dir, 2)?.state).toBe('running');

    const { daemon } = boot(dir);
    const report = await daemon.start();
    expect(report.recovery.tasksRequeued).toBe(2);
    expect(readTask(dir, 1)).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: firstBefore?.runId,
    });
    expect(readTask(dir, 2)).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: secondBefore?.runId,
    });
    await daemon.stop('done');
  });

  it('maxRows=2 queues only the smaller task, then the restart queues the other once', async () => {
    const dir = tempDir();
    seedPair(dir);
    const smaller = readTask(dir, 1);
    const larger = readTask(dir, 2);

    const partial = await startFailure(dir, { SOUL_RECOVERY_MAX_ROWS: '2' });
    expect(incomplete(partial.caught).details).toEqual({ reason: 'row_budget_exceeded' });
    expect(reasonOf(partial.records)).toMatchObject({
      reason: 'row_budget_exceeded',
      tasksRequeued: 1,
    });
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: smaller?.runId });
    expect(readTask(dir, 2)).toMatchObject({ state: 'running', attempt: 1, runId: larger?.runId });
    assertClosed(dir, partial.records);

    const { daemon } = boot(dir);
    const report = await daemon.start();
    expect(report.recovery.tasksRequeued).toBe(1);
    expect(report.recovery.tasksFailed).toBe(0);
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: smaller?.runId });
    expect(readTask(dir, 2)).toMatchObject({ state: 'queued', attempt: 1, runId: larger?.runId });
    await daemon.stop('done');
  });
});

describe('daemon-reproducible incomplete reasons', () => {
  it('persona_budget_exceeded writes nothing until the cap includes every persona', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedPersona(store, 2);
      seedPersona(store, 3);
      seedRunningTask(store, 1, 1);
      seedRunningTask(store, 3, 3);
    });

    const capped = await startFailure(dir, { SOUL_RECOVERY_MAX_PERSONAS: '2' });
    expect(incomplete(capped.caught).details).toEqual({ reason: 'persona_budget_exceeded' });
    expect(reasonOf(capped.records).tasksRequeued).toBe(0);
    expect(readTask(dir, 1, 1)?.state).toBe('running');
    expect(readTask(dir, 3, 3)?.state).toBe('running');
    assertClosed(dir, capped.records);

    const still = await startFailure(dir, { SOUL_RECOVERY_MAX_PERSONAS: '2' });
    expect(incomplete(still.caught).details).toEqual({ reason: 'persona_budget_exceeded' });
    expect(readTask(dir, 1, 1)?.state).toBe('running');

    const run1 = readTask(dir, 1, 1)?.runId;
    const run3 = readTask(dir, 3, 3)?.runId;
    const { daemon } = boot(dir, { SOUL_RECOVERY_MAX_PERSONAS: '3' });
    const report = await daemon.start();
    expect(report.recovery.tasksRequeued).toBe(2);
    expect(readTask(dir, 1, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: run1 });
    expect(readTask(dir, 3, 3)).toMatchObject({ state: 'queued', attempt: 1, runId: run3 });
    await daemon.stop('done');
  });

  it('probe_budget_exceeded with 21 personas queues the smallest persona task, then finishes on the same budget', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      for (let n = 1; n <= 21; n += 1) {
        seedPersona(store, n);
      }
      seedRunningTask(store, 1, 1);
    });
    const before = readTask(dir, 1, 1);

    const first = await startFailure(dir, { SOUL_RECOVERY_MAX_ROWS: '22' });
    expect(incomplete(first.caught).details).toEqual({ reason: 'probe_budget_exceeded' });
    expect(reasonOf(first.records)).toMatchObject({
      reason: 'probe_budget_exceeded',
      tasksRequeued: 1,
    });
    expect(readTask(dir, 1, 1)).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: before?.runId,
    });
    assertClosed(dir, first.records);

    const { daemon } = boot(dir, { SOUL_RECOVERY_MAX_ROWS: '22' });
    const report = await daemon.start();
    expect(report.recovery.tasksRequeued).toBe(0);
    expect(report.recovery.eventsExpired).toBe(0);
    expect(readTask(dir, 1, 1)).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: before?.runId,
    });
    expect(daemon.status.components.scheduler).toMatchObject({
      assembled: true,
      state: 'running',
      dispatchesTasks: false,
    });
    await daemon.stop('done');
  });

  it('probe_budget_exceeded with 20 empty personas writes nothing until the row budget is raised', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      for (let n = 1; n <= 20; n += 1) {
        seedPersona(store, n);
      }
    });
    const env = { SOUL_RECOVERY_BATCH_SIZE: '20', SOUL_RECOVERY_MAX_ROWS: '20' };

    const first = await startFailure(dir, env);
    expect(incomplete(first.caught).details).toEqual({ reason: 'probe_budget_exceeded' });
    expect(reasonOf(first.records).tasksRequeued).toBe(0);
    assertClosed(dir, first.records);

    const second = await startFailure(dir, env);
    expect(incomplete(second.caught).details).toEqual({ reason: 'probe_budget_exceeded' });

    const { daemon } = boot(dir);
    const report = await daemon.start();
    expect(report.recovery).toMatchObject({
      personasNormalized: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      eventsExpired: 0,
    });
    await daemon.stop('done');
  });

  it('aborts from the injected clock as startup_aborted and still keeps the first committed task', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedPersona(store, 2);
      seedRunningTask(store, 1, 1);
      seedRunningTask(store, 2, 2);
    });
    const firstRun = readTask(dir, 1, 1)?.runId;
    const secondRun = readTask(dir, 2, 2)?.runId;

    const { logger, records } = createRecordingLogger();
    const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV });
    const handle: { stop: () => void } = { stop: () => undefined };
    let calls = 0;
    const daemon = new SoulDaemon({
      config,
      logger,
      clock: () => {
        calls += 1;
        if (calls === 2) {
          handle.stop();
        }
        return new Date(NOW);
      },
    });
    handle.stop = () => {
      void daemon.stop('abort-recovery');
    };

    await expect(daemon.start()).rejects.toMatchObject({ code: 'startup_aborted' });
    const stopped = await daemon.stop('abort-recovery');
    expect(stopped.phase).toBe('STOPPED');
    expect(records.some((record) => record['event'] === 'recovery_incomplete')).toBe(false);
    expect(readTask(dir, 1, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: firstRun });
    expect(readTask(dir, 2, 2)).toMatchObject({ state: 'running', attempt: 1, runId: secondRun });
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);

    const next = boot(dir);
    const report = await next.daemon.start();
    expect(report.recovery.tasksRequeued).toBe(1);
    expect(readTask(dir, 1, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: firstRun });
    expect(readTask(dir, 2, 2)).toMatchObject({ state: 'queued', attempt: 1, runId: secondRun });
    await next.daemon.stop('done');
  });

  it('concurrent_modification keeps the first write and converges the raced row later', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedRunningTask(store, 1);
      seedRunningTask(store, 2);
    });
    const firstRun = readTask(dir, 1)?.runId;
    let calls = 0;
    const raced = rid(9);

    const { caught, records } = await startFailure(dir, {}, () => {
      calls += 1;
      if (calls === 3) {
        const store = openStore({ file: join(dir, 'soul.db') });
        try {
          mutate(store, 'UPDATE tasks SET run_id = ? WHERE id = ?', raced, tid(2));
        } finally {
          store.close();
        }
      }
      return new Date(NOW);
    });

    expect(incomplete(caught).details).toEqual({ reason: 'concurrent_modification' });
    expect(reasonOf(records).reason).toBe('concurrent_modification');
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: firstRun });
    expect(readTask(dir, 2)).toMatchObject({ state: 'running', attempt: 1, runId: raced });
    assertClosed(dir, records);

    const { daemon } = boot(dir);
    const report = await daemon.start();
    expect(report.recovery.tasksRequeued).toBe(1);
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: firstRun });
    expect(readTask(dir, 2)).toMatchObject({ state: 'queued', attempt: 1, runId: raced });
    await daemon.stop('done');
  });

  it('archive_state_present expires the clean event and stays incomplete', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedEvent(store, 1, 1, 'received');
      seedEvent(store, 2, 1, 'received');
      mutate(store, "UPDATE events SET archive_state = 'pending' WHERE id = ?", eid(2));
    });

    const first = await startFailure(dir);
    expect(incomplete(first.caught).details).toEqual({ reason: 'archive_state_present' });
    expect(reasonOf(first.records)).toMatchObject({
      reason: 'archive_state_present',
      eventsExpired: 1,
    });
    expect(readEvent(dir, 1)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
    expect(readEvent(dir, 2)).toMatchObject({ status: 'received', archiveState: 'pending' });
    const updated = readEvent(dir, 1)?.updatedAt;
    assertClosed(dir, first.records);

    const second = await startFailure(dir, { SOUL_RECOVERY_MAX_ROWS: '1000000' });
    expect(incomplete(second.caught).details).toEqual({ reason: 'archive_state_present' });
    expect(reasonOf(second.records).eventsExpired).toBe(0);
    expect(readEvent(dir, 1)?.updatedAt).toBe(updated);
    expect(readEvent(dir, 2)?.status).toBe('received');
  });

  it('unexpected_event_status expires the received event and does not clear the noticed row', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedEvent(store, 1, 1, 'received');
      seedEvent(store, 2, 1, 'noticed');
    });

    const first = await startFailure(dir);
    expect(incomplete(first.caught).details).toEqual({ reason: 'unexpected_event_status' });
    expect(readEvent(dir, 1)).toMatchObject({ status: 'expired', statusReason: 'buffer_lost' });
    expect(readEvent(dir, 2)?.status).toBe('noticed');
    const updated = readEvent(dir, 1)?.updatedAt;

    const second = await startFailure(dir);
    expect(incomplete(second.caught).details).toEqual({ reason: 'unexpected_event_status' });
    expect(reasonOf(second.records).eventsExpired).toBe(0);
    expect(readEvent(dir, 1)?.updatedAt).toBe(updated);
    expect(readEvent(dir, 2)?.status).toBe('noticed');
  });

  it('invalid_task_row queues the legal task and leaves attempt 0 in place', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1);
      seedRunningTask(store, 1);
      seedRunningTask(store, 2);
      mutate(store, 'UPDATE tasks SET attempt = 0 WHERE id = ?', tid(2));
    });
    const legal = readTask(dir, 1);

    const first = await startFailure(dir);
    expect(incomplete(first.caught).details).toEqual({ reason: 'invalid_task_row' });
    expect(reasonOf(first.records).tasksRequeued).toBe(1);
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: legal?.runId });
    expect(readTask(dir, 2)).toMatchObject({ state: 'running', attempt: 0 });
    assertClosed(dir, first.records);

    const second = await startFailure(dir);
    expect(incomplete(second.caught).details).toEqual({ reason: 'invalid_task_row' });
    expect(reasonOf(second.records).tasksRequeued).toBe(0);
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 1, runId: legal?.runId });
    expect(readTask(dir, 2)).toMatchObject({ state: 'running', attempt: 0 });
  });
});
