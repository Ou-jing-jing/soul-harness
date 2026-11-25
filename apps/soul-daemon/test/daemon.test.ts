import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { isDaemonError } from '../src/errors.js';
import { API_TOKEN_FILE_NAME } from '../src/api/token.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import type { LogRecord } from './helpers/harness.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-daemon-');
  dirs.push(dir);
  return dir;
}

function makeDaemon(dir: string): { daemon: SoulDaemon; records: LogRecord[] } {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
  const { logger, records } = createRecordingLogger();
  return { daemon: new SoulDaemon({ config, logger }), records };
}

function events(records: LogRecord[], event: string): LogRecord[] {
  return records.filter((record) => record['event'] === event);
}

describe('startup', () => {
  it('reaches RUNNING with a migrated database and a held lock', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir);

    expect(daemon.status.scheduler).toBeNull();

    const report = await daemon.start();

    expect(report.phase).toBe('RUNNING');
    expect(report.appliedMigrations).toStrictEqual([1]);
    expect(report.currentVersion).toBe(1);
    expect(existsSync(join(dir, 'soul.db'))).toBe(true);

    const tokenPath = join(dir, API_TOKEN_FILE_NAME);
    expect(existsSync(tokenPath)).toBe(true);
    const token = readFileSync(tokenPath, 'utf8').replace(/\r?\n$/u, '');
    expect(daemon.verifyApiToken(token)).toBe(true);
    expect(daemon.verifyApiToken(`${token}x`)).toBe(false);
    expect(JSON.stringify(records)).not.toContain(token);

    const lockPath = join(dir, LOCK_FILE_NAME);
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    expect(lock['pid']).toBe(process.pid);

    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);

    // Phase order matches RUNTIME-LIFECYCLE §2.
    const phases = events(records, 'phase_entered').map((record) => record['phase']);
    expect(phases).toStrictEqual(['MIGRATING', 'RECOVERING', 'READY', 'RUNNING']);

    expect(report.skippedSteps).not.toContain('persona_recovery');
    expect(report.skippedSteps).not.toContain('runtime_recovery');
    expect(report.skippedSteps).not.toContain('event_bus');
    expect(report.skippedSteps).not.toContain('scheduler');
    expect(report.skippedSteps).toEqual(['http_api', 'health_check']);
    expect(report.recovery).toEqual({
      personasNormalized: 0,
      personasScanned: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      eventsExpired: 0,
    });
    expect(report.components.personaLifecycle).toEqual({ assembled: true, autoStarted: false });
    expect(report.components.eventBus).toEqual({
      assembled: true,
      initialized: true,
      transport: 'none',
      acceptsInput: false,
    });
    expect(report.components.scheduler).toEqual({
      assembled: true,
      started: true,
      state: 'running',
      handlerKinds: 0,
      dispatchesTasks: false,
    });
    expect(report.capabilities.scheduler).toBe('running');
    expect(report.capabilities.taskDispatch).toBe('unavailable_no_handlers');
    expect(report.capabilities.eventBus).toBe('assembled_no_transport');
    expect(report.capabilities.eventIngress).toBe('unavailable_no_transport');
    expect(report.capabilities.runtimeRecovery).toBe('assembled');
    expect(report.capabilities.httpApi).toBe('not_implemented');
    expect(report.capabilities.healthEndpoint).toBe('not_implemented');
    expect(daemon.status.components).toBe(report.components);
    expect(daemon.status.capabilities).toBe(report.capabilities);
    expect(daemon.status.personaLifecycleAssembled).toBe(true);
    expect(daemon.status.recovery).toEqual(report.recovery);
    expect(daemon.status.scheduler).toEqual({
      state: 'running',
      activeHandlers: 0,
      activeUnits: 0,
    });
    expect(daemon.status.bootId).toBe(report.bootId);
    expect(lock['bootToken']).toBe(report.bootId);

    const running = events(records, 'daemon_running')[0];
    expect(running?.['scheduler']).toBe('running');
    expect(running?.['taskDispatch']).toBe('unavailable_no_handlers');
    expect(running?.['eventIngress']).toBe('unavailable_no_transport');
    expect(running?.['httpApi']).toBe('not_implemented');
    expect(records.some((record) => record['event'] === 'scheduler_started')).toBe(true);
    expect(
      records.some((record) => record['event'] === 'scheduler_started' && record['handlers'] === 0),
    ).toBe(true);

    await daemon.stop('test-finished');
    expect(daemon.verifyApiToken(token)).toBe(false);
    expect(daemon.status.scheduler).toBeNull();
  });

  it('fails before opening the database when the API token file is invalid', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, API_TOKEN_FILE_NAME), 'invalid', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const { daemon } = makeDaemon(dir);

    let caught: unknown;
    try {
      await daemon.start();
    } catch (error) {
      caught = error;
    }

    expect(isDaemonError(caught) && caught.code).toBe('api_token_invalid');
    expect(daemon.phase).toBe('FAILED');
    expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    expect(readFileSync(join(dir, API_TOKEN_FILE_NAME), 'utf8')).toBe('invalid');
  });

  it('fails before opening the database when the lock is taken', async () => {
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const other = (await import('../src/lock.js')).acquireInstanceLock(dir);

    let caught: unknown;
    try {
      await daemon.start();
    } catch (error) {
      caught = error;
    }

    expect(isDaemonError(caught)).toBe(true);
    expect(daemon.phase).toBe('FAILED');
    // The lock failure happens before SQLite or the API token is touched.
    expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    expect(existsSync(join(dir, API_TOKEN_FILE_NAME))).toBe(false);

    other.release();
  });

  it('fails when the data directory is a regular file', async () => {
    const dir = tempDir();
    const path = join(dir, 'not-a-dir');
    writeFileSync(path, 'x');

    const { daemon } = makeDaemon(path);
    let caught: unknown;
    try {
      await daemon.start();
    } catch (error) {
      caught = error;
    }

    // Precise codes survive the boot wrapper: a data-directory failure is not
    // flattened into a generic startup error.
    expect(isDaemonError(caught) && caught.code).toBe('data_dir_invalid');
    expect(existsSync(join(path, 'soul.db'))).toBe(false);
  });

  it('surfaces a migration failure and releases the lock', async () => {
    const dir = tempDir();

    const first = makeDaemon(dir);
    await first.daemon.start();
    await first.daemon.stop('seed');

    const db = new DatabaseSync(join(dir, 'soul.db'));
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('deadbeef');
    db.close();

    const second = makeDaemon(dir);
    let caught: unknown;
    try {
      await second.daemon.start();
    } catch (error) {
      caught = error;
    }

    expect(isDaemonError(caught) && caught.code).toBe('startup_failed');
    expect(caught instanceof Error && caught.message.length > 0).toBe(true);

    // Lock was acquired then released on the failure path.
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);

    // Migration bookkeeping was not repaired.
    const check = new DatabaseSync(join(dir, 'soul.db'));
    const row = check.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get() as {
      checksum?: string;
    };
    check.close();
    expect(row.checksum).toBe('deadbeef');
  });

  it('aborts a boot when a stop is requested while it is still running', async () => {
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const startPromise = daemon.start();
    const stopPromise = daemon.stop('interrupt');

    await expect(startPromise).rejects.toMatchObject({ code: 'startup_aborted' });
    const report = await stopPromise;

    expect(report.phase).toBe('STOPPED');
    // Nothing was left behind.
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });
});

describe('shutdown', () => {
  it('walks the shutdown phases, closes the store and releases the lock', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir);
    await daemon.start();

    const report = await daemon.stop('test');

    expect(report.phase).toBe('STOPPED');
    expect(report.steps.map((step) => step.step)).toStrictEqual([
      'event_bus',
      'scheduler',
      'sqlite_open',
      'instance_lock',
    ]);
    expect(report.steps.every((step) => step.status === 'ok')).toBe(true);

    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.phase).toBe('STOPPED');

    const shutdownPhases = events(records, 'phase_entered')
      .map((record) => record['phase'])
      .filter((phase) => ['DRAINING', 'CLOSING', 'STOPPED'].includes(String(phase)));
    expect(shutdownPhases).toStrictEqual(['DRAINING', 'CLOSING', 'STOPPED']);

    // No checkpoint was fabricated: there is no runtime to produce one.
    expect(events(records, 'checkpoint_skipped')[0]?.['reason']).toBe('runtime_not_implemented');
  });

  it('is idempotent', async () => {
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const first = await daemon.stop('once');
    const second = await daemon.stop('twice');

    expect(second).toBe(first);
  });

  it('reports cleanup failures instead of pretending the shutdown was clean', async () => {
    const dir = tempDir();
    const { daemon, records } = makeDaemon(dir);
    await daemon.start();

    const lockPath = join(dir, LOCK_FILE_NAME);
    rmSync(lockPath, { force: true });
    mkdirSync(lockPath); // a directory cannot be unlinked by the release path

    let caught: unknown;
    try {
      await daemon.stop('broken-lock');
    } catch (error) {
      caught = error;
    }

    expect(isDaemonError(caught) && caught.code).toBe('shutdown_failed');
    expect(daemon.phase).toBe('STOPPED');

    // The other resource was still released: the store release ran first.
    expect(daemon.status.storeOpen).toBe(false);
    expect(events(records, 'cleanup_failed')).toHaveLength(1);

    rmSync(lockPath, { recursive: true, force: true });
  });

  it('can start again after a clean stop', async () => {
    const dir = tempDir();

    const first = makeDaemon(dir);
    await first.daemon.start();
    await first.daemon.stop('first');

    const second = makeDaemon(dir);
    const report = await second.daemon.start();
    expect(report.appliedMigrations).toStrictEqual([]);
    expect(report.currentVersion).toBe(1);

    await second.daemon.stop('second');
  });
});
