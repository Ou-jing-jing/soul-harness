import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Store } from '@soul-harness/persistence';

import { loadConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { isDaemonError } from '../src/errors.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import type { Logger, LogFields } from '../src/logger.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
  type LogRecord,
} from './helpers/harness.js';
import { prepareDatabase, readTask, seedPersona, seedQueuedTask } from './helpers/recovery-seed.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-ready-');
  dirs.push(dir);
  return dir;
}

function makeDaemon(
  dir: string,
  hook?: (event: string, fields: LogFields | undefined, daemon: SoulDaemon) => void,
): { daemon: SoulDaemon; records: LogRecord[] } {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
  const { logger, records } = createRecordingLogger();
  const box: { daemon?: SoulDaemon } = {};
  const wrapped: Logger = {
    level: logger.level,
    debug: (event, fields) => logger.debug(event, fields),
    info: (event, fields) => {
      logger.info(event, fields);
      const current = box.daemon;
      if (current !== undefined) {
        hook?.(event, fields, current);
      }
    },
    warn: (event, fields) => logger.warn(event, fields),
    error: (event, fields) => logger.error(event, fields),
    child: (bindings) => logger.child(bindings),
  };
  const daemon = new SoulDaemon({ config, logger: wrapped });
  box.daemon = daemon;
  return { daemon, records };
}

describe('READY assembly', () => {
  it('does not claim a queued task while the empty scheduler is running', async () => {
    const dir = tempDir();
    prepareDatabase(dir, (store) => {
      seedPersona(store, 1, 'RUNNING');
      seedQueuedTask(store, 1);
    });
    const before = readTask(dir, 1);
    expect(before).toMatchObject({ state: 'queued', attempt: 0, runId: null });

    const { daemon, records } = makeDaemon(dir);
    const report = await daemon.start();

    expect(report.components).toBe(daemon.status.components);
    expect(report.capabilities).toBe(daemon.status.capabilities);
    expect(report.components.scheduler.dispatchesTasks).toBe(false);
    expect(report.components.scheduler.handlerKinds).toBe(0);
    expect(report.components.eventBus.acceptsInput).toBe(false);
    expect(readTask(dir, 1)).toMatchObject({
      state: 'queued',
      attempt: 0,
      runId: before?.runId ?? null,
    });

    const recoveryAt = records.findIndex(
      (record) => record['event'] === 'step_ok' && record['step'] === 'runtime_recovery',
    );
    const createdAt = records.findIndex((record) => record['event'] === 'scheduler_created');
    const startedAt = records.findIndex((record) => record['event'] === 'scheduler_started');
    expect(recoveryAt).toBeGreaterThanOrEqual(0);
    expect(createdAt).toBeGreaterThan(recoveryAt);
    expect(startedAt).toBeGreaterThan(createdAt);
    expect(records.some((record) => record['event'] === 'scheduler_handler_failed')).toBe(false);
    expect(records.some((record) => record['event'] === 'scheduler_settle_conflict')).toBe(false);
    expect(records.some((record) => record['event'] === 'scheduler_settle_failed')).toBe(false);
    expect(JSON.stringify(records)).not.toContain('SECRET-NAME');

    await daemon.stop('done');
    expect(readTask(dir, 1)).toMatchObject({ state: 'queued', attempt: 0, runId: null });
  });

  it('stops the scheduler before closing the store', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir);
    const original = Store.prototype.close;
    let stoppedBeforeClose = false;
    Store.prototype.close = function close(this: Store) {
      stoppedBeforeClose = records.some((record) => record['event'] === 'scheduler_stopped');
      return original.call(this);
    };
    try {
      await daemon.start();
      const report = await daemon.stop('order');
      expect(stoppedBeforeClose).toBe(true);
      expect(report.steps.map((step) => step.step)).toStrictEqual([
        'event_bus',
        'scheduler',
        'sqlite_open',
        'instance_lock',
      ]);
      expect(report.steps.every((step) => step.status === 'ok')).toBe(true);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      expect(daemon.status.storeOpen).toBe(false);
    } finally {
      Store.prototype.close = original;
    }
  });

  it('aborts in READY before creating the ingress', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir, (event, fields, current) => {
      if (event === 'phase_entered' && fields?.['phase'] === 'READY') {
        void current.stop('at-ready');
      }
    });

    const startPromise = daemon.start();
    await expect(startPromise).rejects.toMatchObject({ code: 'startup_aborted' });
    const report = await daemon.stop('at-ready');

    expect(report.phase).toBe('STOPPED');
    expect(isDaemonError(await startPromise.catch((error: unknown) => error))).toBe(true);
    expect(records.some((record) => record['event'] === 'scheduler_created')).toBe(false);
    expect(records.some((record) => record['event'] === 'daemon_running')).toBe(false);
    expect(records.some((record) => record['step'] === 'event_bus')).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('does not start the scheduler when stop arrives after the ingress', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir, (event, fields, current) => {
      if (event === 'step_ok' && fields?.['step'] === 'event_bus') {
        void current.stop('after-ingress');
      }
    });

    await expect(daemon.start()).rejects.toMatchObject({ code: 'startup_aborted' });
    const report = await daemon.stop('after-ingress');

    expect(report.phase).toBe('STOPPED');
    expect(records.some((record) => record['event'] === 'scheduler_created')).toBe(false);
    expect(records.some((record) => record['event'] === 'scheduler_started')).toBe(false);
    expect(records.some((record) => record['event'] === 'daemon_running')).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('does not enter RUNNING when stop arrives after the scheduler has started', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir, (event, fields, current) => {
      if (event === 'step_ok' && fields?.['step'] === 'scheduler') {
        void current.stop('after-scheduler');
      }
    });

    await expect(daemon.start()).rejects.toMatchObject({ code: 'startup_aborted' });
    const report = await daemon.stop('after-scheduler');

    expect(report.phase).toBe('STOPPED');
    expect(records.some((record) => record['event'] === 'scheduler_started')).toBe(true);
    expect(records.some((record) => record['event'] === 'scheduler_stopped')).toBe(true);
    expect(records.some((record) => record['event'] === 'daemon_running')).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    expect(daemon.status.storeOpen).toBe(false);
  });
});
