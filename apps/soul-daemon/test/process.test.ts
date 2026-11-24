import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  SIGNAL_RUNNER,
  buildDaemonApp,
  makeTempDir,
  removeTempDir,
  spawnDaemon,
  type LogRecord,
  type SpawnedDaemon,
} from './helpers/harness.js';
import {
  prepareDatabase,
  readTask,
  seedPersona,
  seedRunningTask,
} from './helpers/recovery-seed.js';

const dirs: string[] = [];
const daemons: SpawnedDaemon[] = [];

afterEach(() => {
  while (daemons.length > 0) {
    const daemon = daemons.pop() as SpawnedDaemon;
    const child: ChildProcess = daemon.child;
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-proc-');
  dirs.push(dir);
  return dir;
}

function isPhase(record: LogRecord, phase: string): boolean {
  return record['event'] === 'phase_entered' && record['phase'] === phase;
}

const TEST_TIMEOUT = 60_000;

beforeAll(() => {
  buildDaemonApp();
}, TEST_TIMEOUT);

describe('real process lifecycle', { timeout: TEST_TIMEOUT }, () => {
  it(
    'rejects a missing data directory with exit code 2',
    async () => {
      const spawned = spawnDaemon({ env: {} });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(2);
      expect(spawned.records.some((record) => record['event'] === 'fatal')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a data directory that is a regular file with exit code 3',
    async () => {
      const dir = tempDir();
      const path = join(dir, 'nope');
      writeFileSync(path, 'x');

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: path } });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(3);
    },
    TEST_TIMEOUT,
  );

  it(
    'starts, and stops cleanly when a signal arrives',
    async () => {
      const dir = tempDir();

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(spawned);

      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));

      const code = await spawned.waitForExit();
      expect(code).toBe(0);
      expect(spawned.records.some((record) => record['event'] === 'signal_received')).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'daemon_stopped')).toBe(true);

      // The database survives the stop; the lock does not.
      expect(existsSync(join(dir, 'soul.db'))).toBe(true);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'holds the lock while RUNNING',
    async () => {
      const dir = tempDir();

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(spawned);
      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));

      const lockPath = join(dir, LOCK_FILE_NAME);
      expect(existsSync(lockPath)).toBe(true);
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      expect(lock['pid']).toBe(spawned.child.pid);
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses a second instance on the same data directory and touches no database',
    async () => {
      const dir = tempDir();

      const first = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(first);
      await first.waitFor((record) => isPhase(record, 'RUNNING'));

      // A second, empty directory keeps the "no database was opened" assertion honest.
      const secondDir = tempDir();
      writeFileSync(
        join(secondDir, LOCK_FILE_NAME),
        JSON.stringify({
          pid: first.child.pid,
          bootToken: 'other',
          startedAt: 'now',
          dataDir: secondDir,
        }),
      );

      const second = spawnDaemon({ env: { SOUL_DATA_DIR: secondDir } });
      daemons.push(second);

      const code = await second.waitForExit();
      expect(code).toBe(4);
      expect(existsSync(join(secondDir, 'soul.db'))).toBe(false);

      expect(first.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'runs two instances on different data directories',
    async () => {
      const a = spawnDaemon({ env: { SOUL_DATA_DIR: tempDir() } });
      const b = spawnDaemon({ env: { SOUL_DATA_DIR: tempDir() } });
      daemons.push(a, b);

      await Promise.all([
        a.waitFor((record) => isPhase(record, 'RUNNING')),
        b.waitFor((record) => isPhase(record, 'RUNNING')),
      ]);

      expect(a.child.pid).not.toBe(b.child.pid);
      expect(a.child.exitCode).toBeNull();
      expect(b.child.exitCode).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    'fails with exit code 5 when migrations fail, and releases the lock',
    async () => {
      const dir = tempDir();

      const seed = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(seed);
      await seed.waitFor((record) => isPhase(record, 'RUNNING'));
      await seed.waitForExit();

      const db = new DatabaseSync(join(dir, 'soul.db'));
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('deadbeef');
      db.close();

      const failing = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(failing);

      const code = await failing.waitForExit();
      expect(code).toBe(5);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'survives a crash: the next start takes over the stale lock and reopens SQLite',
    async () => {
      const dir = tempDir();

      const crashed = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(crashed);
      await crashed.waitFor((record) => isPhase(record, 'RUNNING'));

      crashed.child.kill('SIGKILL');
      const crashCode = await crashed.waitForExit();
      expect(crashCode).not.toBe(0);
      // A killed process cannot have cleaned up or claimed a clean stop.
      expect(crashed.records.some((record) => record['event'] === 'daemon_stopped')).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);

      const restarted = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(restarted);
      await restarted.waitFor((record) => isPhase(record, 'RUNNING'));

      const lock = JSON.parse(
        (await import('node:fs')).readFileSync(join(dir, LOCK_FILE_NAME), 'utf8'),
      ) as Record<string, unknown>;
      expect(lock['pid']).toBe(restarted.child.pid);
      expect(restarted.records.some((record) => record['event'] === 'daemon_running')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'does not delete a lock it cannot prove stale (live foreign pid)',
    async () => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, LOCK_FILE_NAME),
        JSON.stringify({ pid: process.pid, bootToken: 'live', startedAt: 'now', dataDir: dir }),
      );

      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir } });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(4);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(true);
      expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    'finishes recovery, starts the empty scheduler, and still does not dispatch',
    async () => {
      const dir = tempDir();
      const spawned = spawnDaemon({ env: { SOUL_DATA_DIR: dir }, entry: SIGNAL_RUNNER });
      daemons.push(spawned);

      await spawned.waitFor((record) => isPhase(record, 'RUNNING'));
      const code = await spawned.waitForExit();

      expect(code).toBe(0);
      expect(
        spawned.records.some(
          (record) => record['event'] === 'step_ok' && record['step'] === 'runtime_recovery',
        ),
      ).toBe(true);
      expect(
        spawned.records.some(
          (record) => record['event'] === 'scheduler_started' && record['handlers'] === 0,
        ),
      ).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'scheduler_created')).toBe(true);
      expect(
        spawned.records.some(
          (record) =>
            record['event'] === 'daemon_running' &&
            record['taskDispatch'] === 'unavailable_no_handlers' &&
            record['eventIngress'] === 'unavailable_no_transport',
        ),
      ).toBe(true);
      expect(spawned.records.some((record) => record['event'] === 'scheduler_stopped')).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'fails closed on a partial recovery and the next start converges only the remaining task',
    async () => {
      const dir = tempDir();
      prepareDatabase(dir, (store) => {
        seedPersona(store, 1);
        seedRunningTask(store, 1);
        seedRunningTask(store, 2);
      });
      const smaller = readTask(dir, 1);
      const larger = readTask(dir, 2);

      const first = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_RECOVERY_MAX_ROWS: '2' },
      });
      daemons.push(first);
      const firstCode = await first.waitForExit();
      expect(firstCode).toBe(5);
      const incomplete = first.records.find((record) => record['event'] === 'recovery_incomplete');
      expect(incomplete?.['reason']).toBe('row_budget_exceeded');
      expect(incomplete?.['tasksRequeued']).toBe(1);
      expect(first.records.some((record) => record['event'] === 'scheduler_started')).toBe(false);
      expect(first.records.some((record) => record['event'] === 'daemon_running')).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 1,
        runId: smaller?.runId,
      });
      expect(readTask(dir, 2)).toMatchObject({
        state: 'running',
        attempt: 1,
        runId: larger?.runId,
      });

      const second = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_RECOVERY_MAX_ROWS: '10000' },
        entry: SIGNAL_RUNNER,
      });
      daemons.push(second);
      await second.waitFor((record) => isPhase(record, 'RUNNING'));
      const secondCode = await second.waitForExit();
      expect(secondCode).toBe(0);
      const step = second.records.find(
        (record) => record['event'] === 'step_ok' && record['step'] === 'runtime_recovery',
      );
      expect(step?.['tasksRequeued']).toBe(1);
      expect(readTask(dir, 1)).toMatchObject({
        state: 'queued',
        attempt: 1,
        runId: smaller?.runId,
      });
      expect(readTask(dir, 2)).toMatchObject({ state: 'queued', attempt: 1, runId: larger?.runId });
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects a missing task policy before opening the database',
    async () => {
      const dir = tempDir();
      const spawned = spawnDaemon({
        env: { SOUL_DATA_DIR: dir, SOUL_TASK_MAX_ATTEMPTS: '' },
      });
      daemons.push(spawned);

      const code = await spawned.waitForExit();
      expect(code).toBe(2);
      expect(existsSync(join(dir, 'soul.db'))).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
