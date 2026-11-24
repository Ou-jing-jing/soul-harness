/**
 * SH-008D D3 — Scheduler acceptance suite.
 *
 * Everything runs against a real migrated SQLite file. Time is injected through
 * `now`, and timers are a manual queue, so no test sleeps or races the clock.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Channel, PersonaId, TaskId } from '@soul-harness/contracts';
import {
  createRepositories,
  migrate,
  openStore,
  withWrite,
  type Repositories,
  type Store,
  type TaskRow,
} from '@soul-harness/persistence';
import { afterEach, describe, expect, it } from 'vitest';

import * as runtime from '../src/index.js';
import {
  RuntimeError,
  createScheduler,
  isRuntimeError,
  recoverRuntime,
  type RuntimeLogger,
  type SchedulerTimers,
  type TaskScheduler,
} from '../src/index.js';

const NOW = 1_731_700_000_000;
const BODY = '000000000000000000000000';

const pid = (n: number): PersonaId => `psn_${BODY}${String(n).padStart(2, '0')}` as PersonaId;
const tid = (n: number): TaskId => `tsk_${BODY}${String(n).padStart(2, '0')}` as TaskId;

class FakeTimers implements SchedulerTimers {
  private sequence = 0;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = (this.sequence += 1);
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get size(): number {
    return this.pending.size;
  }

  delays(): readonly number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }

  fireNext(): void {
    const first = [...this.pending.entries()][0];
    if (first === undefined) {
      throw new Error('no timer is pending');
    }
    this.pending.delete(first[0]);
    first[1].callback();
  }
}

interface LogEntry {
  readonly level: string;
  readonly event: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

interface Fixture {
  readonly dir: string;
  readonly store: Store;
  readonly repos: Repositories;
  readonly clock: { value: number };
  readonly timers: FakeTimers;
}

const fixtures: Fixture[] = [];
const schedulers: TaskScheduler[] = [];

function openFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'sh-scheduler-'));
  const store = openStore({ file: join(dir, 'soul.db') });
  migrate(store);
  const fixture: Fixture = {
    dir,
    store,
    repos: createRepositories(store),
    clock: { value: NOW },
    timers: new FakeTimers(),
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (schedulers.length > 0) {
    const scheduler = schedulers.pop() as TaskScheduler;
    try {
      await scheduler.stop();
    } catch {
      // A test may have forced an error path; the fixture still gets cleaned.
    }
  }
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as Fixture;
    try {
      fixture.store.close();
    } catch {
      // Already closed.
    }
    rmSync(fixture.dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function captureLogs(): { entries: LogEntry[]; logger: RuntimeLogger } {
  const entries: LogEntry[] = [];
  const push = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    entries.push(fields === undefined ? { level, event } : { level, event, fields });
  };
  return {
    entries,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

function seedPersona(
  fixture: Fixture,
  n: number,
  state: 'RUNNING' | 'SUSPENDED' | 'STOPPED' = 'RUNNING',
): void {
  fixture.repos.personas.insert({
    id: pid(n),
    displayName: `Persona ${n}`,
    state,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

interface SeedTaskOptions {
  readonly persona?: number;
  readonly kind?: string;
  readonly channel?: Channel;
  readonly priority?: number;
  readonly scheduledAt?: number | null;
}

function seedTask(fixture: Fixture, n: number, options: SeedTaskOptions = {}): TaskRow {
  return fixture.repos.tasks.insertQueuedTask({
    id: tid(n),
    personaId: pid(options.persona ?? 1),
    kind: options.kind ?? 'thought.run',
    channel: options.channel ?? 'inner',
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.scheduledAt === undefined ? {} : { scheduledAt: options.scheduledAt }),
  });
}

function taskRow(fixture: Fixture, n: number, persona = 1): TaskRow | null {
  return fixture.repos.tasks.getById({ personaId: pid(persona), id: tid(n) });
}

function makeScheduler(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createScheduler>[0]> = {},
): TaskScheduler {
  const scheduler = createScheduler({
    store: fixture.store,
    logger: silentLogger,
    policy: { maxAttempts: 3, retryBackoffMs: 0 },
    handlers: { 'thought.run': () => undefined },
    now: () => fixture.clock.value,
    timers: fixture.timers,
    ...overrides,
  });
  schedulers.push(scheduler);
  return scheduler;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes microtasks, the pump and every settle chain without sleeping. */
async function flushAll(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return 'no-throw';
  } catch (error) {
    return isRuntimeError(error) ? error.code : 'not-a-runtime-error';
  }
}

const POLICY = { maxAttempts: 3, retryBackoffMs: 0 } as const;

describe('scheduler configuration', () => {
  it('rejects a missing store, logger, policy or handlers', () => {
    const fixture = openFixture();
    const base = {
      store: fixture.store,
      logger: silentLogger,
      policy: POLICY,
      handlers: {},
    };
    for (const options of [
      { ...base, store: undefined },
      { ...base, logger: undefined },
      { ...base, policy: undefined },
      { ...base, handlers: undefined },
    ]) {
      expect(codeOf(() => createScheduler(options as never))).toBe('invalid_argument');
    }
  });

  it('rejects invalid policy values', () => {
    const fixture = openFixture();
    for (const policy of [
      { maxAttempts: 0, retryBackoffMs: 0 },
      { maxAttempts: 101, retryBackoffMs: 0 },
      { maxAttempts: 1.5, retryBackoffMs: 0 },
      { maxAttempts: 3, retryBackoffMs: -1 },
      { maxAttempts: 3, retryBackoffMs: 86_400_001 },
      { maxAttempts: 3, retryBackoffMs: 1.5 },
    ]) {
      expect(
        codeOf(() =>
          createScheduler({
            store: fixture.store,
            logger: silentLogger,
            policy: policy as never,
            handlers: {},
            timers: fixture.timers,
          }),
        ),
      ).toBe('invalid_argument');
    }
  });

  it('rejects invalid concurrency configuration', () => {
    const fixture = openFixture();
    for (const config of [
      { perPersonaChannelConcurrency: 0 },
      { perPersonaChannelConcurrency: 65 },
      { perPersonaChannelConcurrency: 1.5 },
      { maxConcurrentTotal: 0 },
      { maxConcurrentTotal: 1025 },
      { maxConcurrentTotal: 2.5 },
    ]) {
      expect(
        codeOf(() =>
          createScheduler({
            store: fixture.store,
            logger: silentLogger,
            policy: POLICY,
            handlers: {},
            config: config as never,
            timers: fixture.timers,
          }),
        ),
      ).toBe('invalid_argument');
    }
  });

  it('rejects invalid handler maps', () => {
    const fixture = openFixture();
    for (const handlers of [
      { BadKind: () => undefined },
      { ['x'.repeat(65)]: () => undefined },
      { 'thought.run': 42 },
    ]) {
      expect(
        codeOf(() =>
          createScheduler({
            store: fixture.store,
            logger: silentLogger,
            policy: POLICY,
            handlers: handlers as never,
            timers: fixture.timers,
          }),
        ),
      ).toBe('invalid_argument');
    }
  });

  it('rejects an invalid clock before taking the lease', () => {
    const fixture = openFixture();
    expect(
      codeOf(() =>
        createScheduler({
          store: fixture.store,
          logger: silentLogger,
          policy: POLICY,
          handlers: {},
          now: () => -1,
          timers: fixture.timers,
        }),
      ),
    ).toBe('invalid_clock');
    // The lease was never taken: Recovery can run.
    return expect(
      recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY }),
    ).resolves.toBeDefined();
  });

  it('starts in created state with empty stats and applies defaults', async () => {
    const fixture = openFixture();
    const scheduler = makeScheduler(fixture);

    expect(scheduler.state).toBe('created');
    expect(scheduler.stats()).toStrictEqual({
      state: 'created',
      activeHandlers: 0,
      activeUnits: 0,
    });
    await expect(scheduler.tick()).resolves.toStrictEqual({
      personasVisited: 0,
      claimed: 0,
      dispatched: 0,
    });
  });
});

describe('claiming and ordering', () => {
  it('never claims a kind without a registered handler', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1, { kind: 'other.run' });
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await flushAll();

    expect(calls).toHaveLength(0);
    expect(taskRow(fixture, 1)?.state).toBe('queued');
  });

  it('first claim moves attempt 0 → 1 and writes a run id, stable while running', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const gate = deferred();
    let observed: TaskRow | undefined;
    const scheduler = makeScheduler(fixture, {
      handlers: {
        'thought.run': async (task) => {
          observed = task;
          await gate.promise;
        },
      },
    });

    scheduler.start();
    await scheduler.tick();

    expect(observed?.attempt).toBe(1);
    expect(observed?.runId).not.toBeNull();
    const running = taskRow(fixture, 1);
    expect(running).toMatchObject({ state: 'running', attempt: 1, runId: observed?.runId });

    gate.resolve();
    await flushAll();
    expect(taskRow(fixture, 1)).toMatchObject({ state: 'done', attempt: 1 });
  });

  it('a failed handler is retried with attempt + 1 and a new run id', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      policy: { maxAttempts: 3, retryBackoffMs: 1_000 },
      handlers: {
        'thought.run': (task) => {
          calls.push(task);
          if (calls.length === 1) {
            throw new Error('first attempt fails');
          }
        },
      },
    });

    scheduler.start();
    await flushAll();
    const retried = taskRow(fixture, 1);
    expect(retried).toMatchObject({
      state: 'queued',
      attempt: 1,
      scheduledAt: fixture.clock.value + 1_000,
    });
    expect(calls[0]?.runId).not.toBeNull();

    fixture.clock.value += 1_000;
    await scheduler.tick();
    await flushAll();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.attempt).toBe(2);
    expect(calls[1]?.runId).not.toBe(calls[0]?.runId);
    expect(taskRow(fixture, 1)).toMatchObject({ state: 'done', attempt: 2 });
  });

  it('orders by priority descending', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1, { priority: 1 });
    seedTask(fixture, 2, { priority: 5 });
    const order: TaskId[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void order.push(task.id) },
    });

    scheduler.start();
    await flushAll();

    expect(order).toStrictEqual([tid(2), tid(1)]);
  });

  it('places NULL scheduled_at last', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    seedTask(fixture, 2, { scheduledAt: NOW - 10 });
    const order: TaskId[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void order.push(task.id) },
    });

    scheduler.start();
    await flushAll();

    expect(order).toStrictEqual([tid(2), tid(1)]);
  });

  it('orders scheduled_at ascending, then id ascending', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1, { scheduledAt: NOW - 10 });
    seedTask(fixture, 2, { scheduledAt: NOW - 20 });
    seedTask(fixture, 3, { scheduledAt: NOW - 20 });
    const order: TaskId[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void order.push(task.id) },
    });

    scheduler.start();
    await flushAll();

    expect(order).toStrictEqual([tid(2), tid(3), tid(1)]);
  });

  it('does not claim a task before its scheduled time', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1, { scheduledAt: NOW + 5_000 });
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await flushAll();

    expect(calls).toHaveLength(0);
    expect(taskRow(fixture, 1)?.state).toBe('queued');
    expect(fixture.timers.delays()).toStrictEqual([5_000]);
  });

  it('does not claim tasks whose persona is not RUNNING', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1, 'SUSPENDED');
    seedTask(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await flushAll();

    expect(calls).toHaveLength(0);
    expect(taskRow(fixture, 1)?.state).toBe('queued');
  });
});

describe('concurrency and fairness', () => {
  it('enforces the per Persona × channel limit', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    seedTask(fixture, 2);
    const gate = deferred();
    let active = 0;
    let peak = 0;
    const scheduler = makeScheduler(fixture, {
      config: { perPersonaChannelConcurrency: 1, maxConcurrentTotal: 8 },
      handlers: {
        'thought.run': async () => {
          active += 1;
          peak = Math.max(peak, active);
          try {
            await gate.promise;
          } finally {
            active -= 1;
          }
        },
      },
    });

    scheduler.start();
    await flushAll();
    expect(peak).toBe(1);
    expect(scheduler.stats().activeHandlers).toBe(1);

    gate.resolve();
    await flushAll();
    expect(peak).toBe(1);
    expect(active).toBe(0);
  });

  it('enforces the global limit across Persona × channel units', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedPersona(fixture, 2);
    seedTask(fixture, 1, { persona: 1 });
    seedTask(fixture, 2, { persona: 2 });
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const scheduler = makeScheduler(fixture, {
      config: { perPersonaChannelConcurrency: 1, maxConcurrentTotal: 1 },
      handlers: {
        'thought.run': async () => {
          active += 1;
          peak = Math.max(peak, active);
          const gate = deferred();
          gates.push(gate.resolve);
          try {
            await gate.promise;
          } finally {
            active -= 1;
          }
        },
      },
    });

    scheduler.start();
    await flushAll();
    expect(peak).toBe(1);

    while (gates.length > 0) {
      gates.shift()?.();
      await flushAll();
    }
    expect(peak).toBe(1);
  });

  it('runs different Persona × channel units in parallel', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedPersona(fixture, 2);
    seedTask(fixture, 1, { persona: 1 });
    seedTask(fixture, 2, { persona: 2 });
    const gate = deferred();
    let started = 0;
    const scheduler = makeScheduler(fixture, {
      config: { perPersonaChannelConcurrency: 1, maxConcurrentTotal: 4 },
      handlers: {
        'thought.run': async () => {
          started += 1;
          await gate.promise;
        },
      },
    });

    scheduler.start();
    await flushAll();

    expect(started).toBe(2);
    expect(scheduler.stats().activeHandlers).toBe(2);
    gate.resolve();
    await flushAll();
  });

  it('rotates units so later personas are not starved', async () => {
    const fixture = openFixture();
    for (const n of [1, 2, 3]) {
      seedPersona(fixture, n);
      seedTask(fixture, n, { persona: n });
    }
    const order: PersonaId[] = [];
    const scheduler = makeScheduler(fixture, {
      config: { perPersonaChannelConcurrency: 1, maxConcurrentTotal: 1 },
      handlers: { 'thought.run': (task) => void order.push(task.personaId) },
    });

    scheduler.start();
    await flushAll();

    expect(order).toHaveLength(3);
    expect(new Set(order)).toStrictEqual(new Set([pid(1), pid(2), pid(3)]));
  });
});

describe('settlement', () => {
  it('completes a successful handler through completeTask', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const scheduler = makeScheduler(fixture, { handlers: { 'thought.run': () => undefined } });

    scheduler.start();
    await flushAll();

    expect(taskRow(fixture, 1)).toMatchObject({ state: 'done', attempt: 1 });
    expect(taskRow(fixture, 1)?.finishedAt).toBe(fixture.clock.value);
  });

  it('applies the fixed retry backoff', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const scheduler = makeScheduler(fixture, {
      policy: { maxAttempts: 3, retryBackoffMs: 500 },
      handlers: {
        'thought.run': () => {
          throw new Error('boom');
        },
      },
    });

    scheduler.start();
    await flushAll();

    expect(taskRow(fixture, 1)).toMatchObject({
      state: 'queued',
      attempt: 1,
      scheduledAt: fixture.clock.value + 500,
    });
  });

  it('fails the task once maxAttempts is reached', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    let calls = 0;
    const scheduler = makeScheduler(fixture, {
      policy: { maxAttempts: 2, retryBackoffMs: 0 },
      handlers: {
        'thought.run': () => {
          calls += 1;
          throw new Error('always fails');
        },
      },
    });

    scheduler.start();
    await flushAll();
    expect(calls).toBe(2);
    expect(taskRow(fixture, 1)).toMatchObject({ state: 'failed', attempt: 2 });
  });

  it('does not blind-write when the settle CAS misses', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const gate = deferred();
    const scheduler = makeScheduler(fixture, {
      handlers: {
        'thought.run': async () => {
          await gate.promise;
        },
      },
    });

    scheduler.start();
    await scheduler.tick();
    withWrite(fixture.store, (tx) => {
      tx.prepare('UPDATE tasks SET attempt = 99 WHERE id = ?').run(tid(1));
    });

    gate.resolve();
    await flushAll();

    expect(taskRow(fixture, 1)).toMatchObject({ state: 'running', attempt: 99 });
  });

  it('reports a failure settle CAS miss without overwriting the row', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const gate = deferred();
    const { entries, logger } = captureLogs();
    const scheduler = makeScheduler(fixture, {
      logger,
      handlers: {
        'thought.run': async () => {
          await gate.promise;
        },
      },
    });

    scheduler.start();
    await scheduler.tick();
    withWrite(fixture.store, (tx) => {
      tx.prepare('UPDATE tasks SET run_id = ?, attempt = ? WHERE id = ?').run(
        'run_00000000000000000000000009',
        7,
        tid(1),
      );
    });
    const mutated = taskRow(fixture, 1);
    expect(mutated).toMatchObject({
      state: 'running',
      attempt: 7,
      runId: 'run_00000000000000000000000009',
    });

    gate.reject(new Error('handler failed after a concurrent change'));
    await flushAll();

    expect(taskRow(fixture, 1)).toStrictEqual(mutated);
    const conflict = entries.find((entry) => entry.event === 'scheduler_settle_conflict');
    expect(conflict?.fields).toMatchObject({
      personaId: pid(1),
      taskId: tid(1),
      attempt: 1,
      code: 'concurrent_modification',
    });
    expect(JSON.stringify(entries)).not.toContain('handler failed after a concurrent change');
    expect(scheduler.stats().activeHandlers).toBe(0);

    await scheduler.stop();
    expect(scheduler.state).toBe('stopped');
    await expect(
      recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY }),
    ).resolves.toBeDefined();
  });

  function installSettleTrigger(fixture: Fixture, when: string): void {
    withWrite(fixture.store, (tx) => {
      tx.prepare(
        `CREATE TEMP TRIGGER audit_settle_block BEFORE UPDATE ON tasks WHEN ${when} BEGIN SELECT RAISE(ABORT, 'transient settle failure'); END`,
      ).run();
    });
  }

  function dropSettleTrigger(fixture: Fixture): void {
    withWrite(fixture.store, (tx) => {
      tx.prepare('DROP TRIGGER IF EXISTS audit_settle_block').run();
    });
  }

  it('retries a completion that failed to commit without running the handler again', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    installSettleTrigger(fixture, "NEW.state = 'done'");
    let calls = 0;
    const { entries, logger } = captureLogs();
    const scheduler = makeScheduler(fixture, {
      logger,
      handlers: {
        'thought.run': () => {
          calls += 1;
        },
      },
    });

    scheduler.start();
    await flushAll();

    const stuck = taskRow(fixture, 1);
    expect(stuck).toMatchObject({ state: 'running', attempt: 1 });
    expect(calls).toBe(1);
    expect(entries.some((entry) => entry.event === 'scheduler_settle_failed')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('transient settle failure');
    expect(fixture.timers.size).toBe(1);

    dropSettleTrigger(fixture);
    fixture.timers.fireNext();
    await flushAll();

    expect(calls).toBe(1);
    expect(taskRow(fixture, 1)).toMatchObject({
      state: 'done',
      attempt: 1,
      runId: stuck?.runId,
      finishedAt: fixture.clock.value,
    });
    expect(entries.some((entry) => entry.event === 'scheduler_settle_recovered')).toBe(true);
  });

  it('retries a failure settle that failed to commit and does not rerun the handler', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    installSettleTrigger(fixture, "NEW.state = 'queued'");
    let calls = 0;
    const scheduler = makeScheduler(fixture, {
      policy: { maxAttempts: 3, retryBackoffMs: 500 },
      handlers: {
        'thought.run': () => {
          calls += 1;
          throw new Error('handler boom');
        },
      },
    });

    scheduler.start();
    await flushAll();

    const stuck = taskRow(fixture, 1);
    expect(stuck).toMatchObject({ state: 'running', attempt: 1 });
    expect(calls).toBe(1);
    expect(JSON.stringify(stuck)).not.toContain('handler boom');

    dropSettleTrigger(fixture);
    fixture.timers.fireNext();

    expect(calls).toBe(1);
    expect(taskRow(fixture, 1)).toMatchObject({
      state: 'queued',
      attempt: 1,
      runId: stuck?.runId,
      scheduledAt: fixture.clock.value + 500,
    });
  });

  it('leaves a task RUNNING when a settle retry never commits', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    installSettleTrigger(fixture, "NEW.state = 'done'");
    let calls = 0;
    const { entries, logger } = captureLogs();
    const scheduler = makeScheduler(fixture, {
      logger,
      handlers: {
        'thought.run': () => {
          calls += 1;
        },
      },
    });

    scheduler.start();
    await flushAll();
    const stuck = taskRow(fixture, 1);
    expect(stuck?.state).toBe('running');

    await scheduler.stop();

    expect(calls).toBe(1);
    expect(scheduler.state).toBe('stopped');
    expect(fixture.timers.size).toBe(0);
    expect(taskRow(fixture, 1)).toMatchObject({
      state: 'running',
      attempt: 1,
      runId: stuck?.runId,
    });
    expect(entries.some((entry) => entry.event === 'scheduler_settle_abandoned')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('transient settle failure');
  });

  it('Recovery requeues a crashed run without bumping attempt', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const runId = 'run_00000000000000000000000001' as never;
    fixture.repos.tasks.claimNext({
      personaId: pid(1),
      channel: 'inner',
      now: NOW,
      runId,
      maxAttempts: 3,
      kinds: ['thought.run'],
    });

    const report = await recoverRuntime({
      store: fixture.store,
      logger: silentLogger,
      policy: POLICY,
      now: () => NOW,
    });

    expect(report.tasks.requeued).toBe(1);
    expect(taskRow(fixture, 1)).toMatchObject({ state: 'queued', attempt: 1 });
  });
});

describe('pause / resume / cancel', () => {
  it('pauses and resumes a queued task', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const scheduler = makeScheduler(fixture);

    const paused = await scheduler.pauseTask({ personaId: pid(1), taskId: tid(1) });
    expect(paused.state).toBe('paused');
    expect((await scheduler.cancelTask({ personaId: pid(1), taskId: tid(1) })).state).toBe(
      'cancelled',
    );

    seedTask(fixture, 2);
    await scheduler.pauseTask({ personaId: pid(1), taskId: tid(2) });
    const resumed = await scheduler.resumeTask({ personaId: pid(1), taskId: tid(2) });
    expect(resumed.state).toBe('queued');
  });

  it('cancels queued and paused tasks, but never a running task', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    seedTask(fixture, 2);
    seedTask(fixture, 3);
    const gate = deferred();
    const scheduler = makeScheduler(fixture, {
      handlers: {
        'thought.run': async () => {
          await gate.promise;
        },
      },
    });

    await expect(
      scheduler.cancelTask({ personaId: pid(1), taskId: tid(1) }),
    ).resolves.toMatchObject({ state: 'cancelled' });
    await scheduler.pauseTask({ personaId: pid(1), taskId: tid(2) });
    await expect(
      scheduler.cancelTask({ personaId: pid(1), taskId: tid(2) }),
    ).resolves.toMatchObject({ state: 'cancelled' });

    scheduler.start();
    await scheduler.tick();
    const runningId = [tid(3)];
    expect(taskRow(fixture, 3)).toMatchObject({ state: 'running' });
    await expect(
      scheduler.cancelTask({ personaId: pid(1), taskId: runningId[0] as TaskId }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    expect(taskRow(fixture, 3)).toMatchObject({ state: 'running' });
    gate.resolve();
    await flushAll();
  });

  it('rejects illegal transitions without touching the row', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const scheduler = makeScheduler(fixture);

    await expect(scheduler.resumeTask({ personaId: pid(1), taskId: tid(1) })).rejects.toMatchObject(
      {
        code: 'illegal_transition',
      },
    );
    expect(taskRow(fixture, 1)?.state).toBe('queued');
    await expect(scheduler.pauseTask({ personaId: pid(2), taskId: tid(1) })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('classifies an invalid attempt and an exhausted attempt on resume', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    seedTask(fixture, 2);
    withWrite(fixture.store, (tx) => {
      tx.prepare("UPDATE tasks SET state = 'paused', attempt = 1.5 WHERE id = ?").run(tid(1));
      tx.prepare("UPDATE tasks SET state = 'paused', attempt = 3 WHERE id = ?").run(tid(2));
    });
    const scheduler = makeScheduler(fixture);

    await expect(scheduler.resumeTask({ personaId: pid(1), taskId: tid(1) })).rejects.toMatchObject(
      {
        code: 'illegal_task_row',
      },
    );
    await expect(scheduler.resumeTask({ personaId: pid(1), taskId: tid(2) })).rejects.toMatchObject(
      {
        code: 'task_exhausted',
      },
    );
  });

  it('a CAS miss is reported and never blind-written', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    let calls = 0;
    const scheduler = makeScheduler(fixture, {
      now: () => {
        calls += 1;
        if (calls === 2) {
          withWrite(fixture.store, (tx) => {
            tx.prepare("UPDATE tasks SET state = 'cancelled' WHERE id = ?").run(tid(1));
          });
        }
        return fixture.clock.value;
      },
    });

    await expect(scheduler.cancelTask({ personaId: pid(1), taskId: tid(1) })).rejects.toMatchObject(
      {
        code: 'illegal_transition',
      },
    );
    expect(taskRow(fixture, 1)?.state).toBe('cancelled');
  });
});

describe('lifecycle, stop and leases', () => {
  it('starts once and rejects a second start', () => {
    const fixture = openFixture();
    const scheduler = makeScheduler(fixture);
    scheduler.start();
    expect(scheduler.state).toBe('running');
    expect(codeOf(() => scheduler.start())).toBe('illegal_transition');
  });

  it('stop waits for an in-flight handler and its settlement', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const gate = deferred();
    const scheduler = makeScheduler(fixture, {
      handlers: {
        'thought.run': async () => {
          await gate.promise;
        },
      },
    });

    scheduler.start();
    await scheduler.tick();
    const stopping = scheduler.stop();
    await flushAll();
    expect(scheduler.state).toBe('stopping');
    expect(taskRow(fixture, 1)?.state).toBe('running');

    gate.resolve();
    await stopping;
    expect(scheduler.state).toBe('stopped');
    expect(taskRow(fixture, 1)).toMatchObject({ state: 'done' });
  });

  it('does not dispatch anything after stop begins', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await scheduler.stop();
    seedTask(fixture, 1);
    scheduler.wake();
    await flushAll();
    await scheduler.tick();
    await flushAll();

    expect(calls).toHaveLength(0);
    expect(taskRow(fixture, 1)?.state).toBe('queued');
  });

  it('cannot restart after stop and repeated stop is idempotent', async () => {
    const fixture = openFixture();
    const scheduler = makeScheduler(fixture);
    scheduler.start();
    await scheduler.stop();
    expect(scheduler.state).toBe('stopped');
    expect(codeOf(() => scheduler.start())).toBe('illegal_transition');
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('releases the lease so Recovery can run after stop', async () => {
    const fixture = openFixture();
    const scheduler = makeScheduler(fixture);
    scheduler.start();
    await scheduler.stop();

    await expect(
      recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY }),
    ).resolves.toMatchObject({ incomplete: null });
  });

  it('rejects a second scheduler for the same Store', () => {
    const fixture = openFixture();
    makeScheduler(fixture);
    expect(codeOf(() => makeScheduler(fixture))).toBe('illegal_transition');
  });

  it('rejects Recovery while a scheduler owns the Store', async () => {
    const fixture = openFixture();
    const scheduler = makeScheduler(fixture);
    await expect(
      recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY }),
    ).rejects.toMatchObject({ code: 'illegal_transition' });
    scheduler.wake();
  });

  it('rejects scheduler creation while Recovery holds the lease', async () => {
    const fixture = openFixture();
    const pending = recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY });
    expect(codeOf(() => makeScheduler(fixture))).toBe('illegal_transition');
    await pending;
  });

  it('releases the Recovery lease after a successful run', async () => {
    const fixture = openFixture();
    await recoverRuntime({ store: fixture.store, logger: silentLogger, policy: POLICY });

    expect(codeOf(() => makeScheduler(fixture))).toBe('no-throw');
  });

  it('releases the Recovery lease on the error path', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const runId = 'run_00000000000000000000000002' as never;
    fixture.repos.tasks.claimNext({
      personaId: pid(1),
      channel: 'inner',
      now: NOW,
      runId,
      maxAttempts: 3,
      kinds: ['thought.run'],
    });
    let calls = 0;
    await expect(
      recoverRuntime({
        store: fixture.store,
        logger: silentLogger,
        policy: POLICY,
        now: () => {
          calls += 1;
          return calls === 1 ? NOW : -1;
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_clock' });

    expect(codeOf(() => makeScheduler(fixture))).toBe('no-throw');
  });

  it('reports stats for active handlers and units', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const gate = deferred();
    const scheduler = makeScheduler(fixture, {
      handlers: {
        'thought.run': async () => {
          await gate.promise;
        },
      },
    });
    scheduler.start();
    await scheduler.tick();

    expect(scheduler.stats()).toStrictEqual({
      state: 'running',
      activeHandlers: 1,
      activeUnits: 1,
    });
    gate.resolve();
    await flushAll();
    expect(scheduler.stats().activeHandlers).toBe(0);
  });
});

describe('wake-ups and timers', () => {
  it('schedules exactly one earliest-due timer and claims when it fires', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1, { scheduledAt: NOW + 1_000 });
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await flushAll();
    expect(fixture.timers.size).toBe(1);
    expect(fixture.timers.delays()).toStrictEqual([1_000]);

    fixture.clock.value = NOW + 1_000;
    fixture.timers.fireNext();
    await flushAll();
    expect(calls).toHaveLength(1);
  });

  it('does not busy-poll when there is nothing to run', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    const scheduler = makeScheduler(fixture);

    scheduler.start();
    await flushAll();

    expect(fixture.timers.size).toBe(0);
    expect(scheduler.tick()).resolves.toStrictEqual({
      personasVisited: 1,
      claimed: 0,
      dispatched: 0,
    });
  });

  it('explicit wake() picks up work after a persona becomes RUNNING', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1, 'SUSPENDED');
    seedTask(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    scheduler.start();
    await flushAll();
    expect(calls).toHaveLength(0);

    fixture.repos.personas.updateState({ id: pid(1), state: 'RUNNING', updatedAt: NOW + 1 });
    scheduler.wake();
    await flushAll();

    expect(calls).toHaveLength(1);
  });

  it('enqueueTask creates a queued task and wakes the pump', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    const created = await scheduler.enqueueTask({
      personaId: pid(1),
      kind: 'thought.run',
      channel: 'inner',
    });
    expect(created).toMatchObject({ state: 'queued', attempt: 0, personaId: pid(1) });

    scheduler.start();
    await flushAll();
    expect(calls).toHaveLength(1);
  });

  it('rejects enqueue for an unregistered kind and writes no task row', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    const calls: TaskRow[] = [];
    const scheduler = makeScheduler(fixture, {
      handlers: { 'thought.run': (task) => void calls.push(task) },
    });

    await expect(
      scheduler.enqueueTask({ personaId: pid(1), kind: 'missing.run', channel: 'inner' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(
      fixture.repos.tasks.listByPersonaState({ personaId: pid(1), state: 'queued' }),
    ).toStrictEqual([]);

    // The other path — a row inserted directly through persistence — is never
    // claimed either, so the Scheduler check cannot be bypassed.
    fixture.repos.tasks.insertQueuedTask({
      id: tid(9),
      personaId: pid(1),
      kind: 'missing.run',
      channel: 'inner',
    });
    scheduler.start();
    await flushAll();

    expect(calls).toHaveLength(0);
    expect(taskRow(fixture, 9)).toMatchObject({ state: 'queued', attempt: 0 });
  });
});

describe('safety', () => {
  it('never logs payload references, error messages or stacks', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    const secret = 'TOP-SECRET-MESSAGE-do-not-log';
    const payloadEventId = 'evt_00000000000000000000000077';
    seedTask(fixture, 1);
    const { entries, logger } = captureLogs();
    const scheduler = makeScheduler(fixture, {
      logger,
      handlers: {
        'thought.run': () => {
          throw new Error(secret);
        },
      },
    });
    await scheduler.enqueueTask({
      personaId: pid(1),
      kind: 'thought.run',
      channel: 'inner',
      payloadRefs: { eventId: payloadEventId as never },
    });

    scheduler.start();
    await flushAll();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(payloadEventId);
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('at ');
    expect(entries.some((entry) => entry.event === 'scheduler_handler_failed')).toBe(true);
  });

  it('does not touch SQLite directly', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'scheduler');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) {
        continue;
      }
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text).not.toMatch(/DatabaseSync|node:sqlite|\.prepare\(/);
      expect(text).not.toMatch(/\b(INSERT INTO|UPDATE tasks|DELETE FROM)\b/);
    }
  });

  it('exports the public scheduler API but not the lease internals', () => {
    expect(typeof runtime.createScheduler).toBe('function');
    expect('acquireStoreLease' in runtime).toBe(false);
    expect('hasStoreLease' in runtime).toBe(false);
  });

  it('stops on a throwing logger without losing the run', async () => {
    const fixture = openFixture();
    seedPersona(fixture, 1);
    seedTask(fixture, 1);
    const throwing = {
      debug: () => {
        throw new Error('logger down');
      },
      info: () => {
        throw new Error('logger down');
      },
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };
    const scheduler = makeScheduler(fixture, { logger: throwing });

    scheduler.start();
    await flushAll();

    expect(taskRow(fixture, 1)?.state).toBe('done');
  });

  it('uses RuntimeError codes for classification', () => {
    expect(new RuntimeError('illegal_task_row', 'x').code).toBe('illegal_task_row');
    expect(new RuntimeError('task_exhausted', 'x').code).toBe('task_exhausted');
  });
});
