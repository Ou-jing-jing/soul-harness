import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type DaemonConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { DaemonError } from '../src/errors.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';

import type {
  SchedulerOptions,
  StimulusIngress,
  StimulusIngressOptions,
  TaskScheduler,
} from '@soul-harness/runtime';

interface RuntimeModule {
  createStimulusIngress(options: StimulusIngressOptions): StimulusIngress;
  createScheduler(options: SchedulerOptions): TaskScheduler;
}

interface SeenIngress {
  readonly store: object;
  readonly config: object;
  readonly now: () => number;
}

interface SeenScheduler {
  readonly store: object;
  readonly policy: object;
  readonly config: object | undefined;
  readonly handlers: unknown;
  readonly now: () => number;
}

const control = vi.hoisted(() => {
  return {
    mode: 'passthrough' as
      'passthrough' | 'ingress' | 'scheduler-create' | 'scheduler-start' | 'stop-hang',
    ingress: [] as SeenIngress[],
    schedulers: [] as SeenScheduler[],
    ingressCloses: 0,
    stopCalls: 0,
    releaseStop: null as (() => void) | null,
  };
});

vi.mock('@soul-harness/runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as RuntimeModule & Record<string, unknown>;
  return {
    ...actual,
    createStimulusIngress(
      options: Parameters<typeof actual.createStimulusIngress>[0],
    ): ReturnType<typeof actual.createStimulusIngress> {
      if (control.mode === 'ingress') {
        throw new Error('ingress refused');
      }
      control.ingress.push({
        store: options.store,
        config: options.config,
        now: options.now ?? Date.now,
      });
      const ingress = actual.createStimulusIngress(options);
      return new Proxy(ingress, {
        get(target, prop, receiver) {
          if (prop === 'close') {
            return () => {
              control.ingressCloses += 1;
              target.close();
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
    createScheduler(
      options: Parameters<typeof actual.createScheduler>[0],
    ): ReturnType<typeof actual.createScheduler> {
      control.schedulers.push({
        store: options.store,
        policy: options.policy,
        config: options.config,
        handlers: options.handlers,
        now: options.now ?? Date.now,
      });
      if (control.mode === 'scheduler-create') {
        throw new Error('scheduler refused');
      }
      if (control.mode === 'stop-hang') {
        let resolveStop: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          resolveStop = resolve;
        });
        control.releaseStop = resolveStop;
        const hanging = {
          get state() {
            return 'running' as const;
          },
          start() {
            return undefined;
          },
          stop() {
            control.stopCalls += 1;
            return gate;
          },
          wake() {
            return undefined;
          },
          tick: () => Promise.resolve({ personasVisited: 0, claimed: 0, dispatched: 0 }),
          enqueueTask: () => Promise.reject(new Error('no handler')),
          pauseTask: () => Promise.reject(new Error('no handler')),
          resumeTask: () => Promise.reject(new Error('no handler')),
          cancelTask: () => Promise.reject(new Error('no handler')),
          stats: () => ({ state: 'running' as const, activeHandlers: 0, activeUnits: 0 }),
        };
        return hanging;
      }
      const scheduler = actual.createScheduler(options);
      if (control.mode === 'scheduler-start') {
        return new Proxy(scheduler, {
          get(target, prop, receiver) {
            if (prop === 'start') {
              return () => {
                throw new Error('start refused');
              };
            }
            if (prop === 'stop') {
              return () => {
                control.stopCalls += 1;
                return target.stop();
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      }
      return scheduler;
    },
  };
});

const dirs: string[] = [];

beforeEach(() => {
  control.mode = 'passthrough';
  control.ingress.length = 0;
  control.schedulers.length = 0;
  control.ingressCloses = 0;
  control.stopCalls = 0;
  control.releaseStop = null;
});

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-ready-fail-');
  dirs.push(dir);
  return dir;
}

function makeDaemon(dir: string): { daemon: SoulDaemon; config: DaemonConfig } {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
  const { logger } = createRecordingLogger();
  return { daemon: new SoulDaemon({ config, logger }), config };
}

describe('READY failure paths', () => {
  it('passes one store, one policy, and the frozen ingress config', async () => {
    const dir = tempDir();
    const { daemon, config } = makeDaemon(dir);
    await daemon.start();

    expect(control.ingress).toHaveLength(1);
    expect(control.schedulers).toHaveLength(1);
    const ingress = control.ingress[0];
    const scheduler = control.schedulers[0];
    if (ingress === undefined || scheduler === undefined) {
      throw new Error('assembly was not observed');
    }
    expect(ingress.store).toBe(scheduler.store);
    expect(ingress.config).toBe(config.ingress);
    expect(scheduler.policy).toBe(config.policy);
    expect(scheduler.config).toBe(config.scheduler);
    expect(ingress.now).toBe(scheduler.now);
    expect(scheduler.handlers).toBeInstanceOf(Map);
    expect((scheduler.handlers as Map<string, unknown>).size).toBe(0);

    await daemon.stop('done');
  });

  it('maps ingress construction failure and does not create a scheduler', async () => {
    control.mode = 'ingress';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonError);
    expect(caught).toMatchObject({
      code: 'event_bus_start_failed',
      message: 'event bus failed to start',
    });
    expect((caught as DaemonError).details).toBeUndefined();
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(((caught as Error).cause as Error).message).toBe('ingress refused');
    expect(control.schedulers).toHaveLength(0);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    expect(daemon.phase).toBe('FAILED');
  });

  it('maps scheduler construction failure and still closes the ingress', async () => {
    control.mode = 'scheduler-create';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: 'scheduler_start_failed',
      message: 'scheduler failed to start',
    });
    expect((caught as DaemonError).details).toBeUndefined();
    expect(control.ingressCloses).toBe(1);
    expect(control.schedulers).toHaveLength(1);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('stops a created scheduler when start() throws', async () => {
    control.mode = 'scheduler-start';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);

    const caught = await daemon.start().catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: 'scheduler_start_failed' });
    expect(control.stopCalls).toBe(1);
    expect(control.ingressCloses).toBe(1);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);

    control.mode = 'passthrough';
    const second = makeDaemon(dir);
    const report = await second.daemon.start();
    expect(report.phase).toBe('RUNNING');
    await second.daemon.stop('done');
  });

  it('does not close the store until the scheduler stop promise resolves', async () => {
    control.mode = 'stop-hang';
    const dir = tempDir();
    const { daemon } = makeDaemon(dir);
    await daemon.start();

    const stopPromise = daemon.stop('hang');
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(control.ingressCloses).toBe(1);
    expect(control.stopCalls).toBe(1);
    expect(daemon.status.storeOpen).toBe(true);
    expect(daemon.status.lockHeld).toBe(true);
    expect(daemon.phase).toBe('CLOSING');

    const release = control.releaseStop;
    if (release === null) {
      throw new Error('stop gate was not installed');
    }
    release();
    const report = await stopPromise;
    expect(report.phase).toBe('STOPPED');
    expect(report.steps.every((step) => step.status === 'ok')).toBe(true);
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
  });
});
