/**
 * SH-008D D3 — in-process task scheduler.
 *
 * Scope: claim → dispatch → settle over the existing persistence repositories.
 * No SQL, no migrations, no Daemon wiring, no cross-process coordination.
 *
 * Approved decisions implemented here:
 *   P1  immutable handler map at creation; no runtime registration
 *   P2  fixed retry backoff (`now + retryBackoffMs`)
 *   P3  every handler error is retryable until `maxAttempts`
 *   P4  round-robin over Persona × channel units
 *   P5  stop waits for in-flight handlers; never restarts
 *   P6  event-driven wake + one-shot earliest-due timer
 *   P7  Store-scoped Recovery/Scheduler lease
 *   P8  lease is taken at creation; released only when stop completes
 *
 * A settle write that throws is remembered and retried with the same CAS.
 * The handler is not run again. If stop finishes before a retry commits, the
 * row stays RUNNING so the next boot's Recovery can requeue it.
 */

import { CHANNELS } from '@soul-harness/contracts';
import type { Channel, PersonaId, RunId, TaskId } from '@soul-harness/contracts';
import { isRunId } from '@soul-harness/contracts';
import {
  createRepositories,
  isPersistenceError,
  type PersonaRow,
  type Store,
  type TaskPayloadRefs,
  type TaskRow,
} from '@soul-harness/persistence';

import { readClock } from '../clock.js';
import { RuntimeError, isRuntimeError } from '../errors.js';
import { allocateRunId, allocateTaskId } from '../ids/allocate.js';
import type { RuntimeLogger } from '../persona/lifecycle.js';
import { acquireStoreLease } from '../store-lease.js';

export interface SchedulerPolicy {
  /** Required, no library default (D-RT2). Assembly supplies the same value to Recovery. */
  readonly maxAttempts: number;
  /** Required, no library default (D-RT3). Fixed backoff in milliseconds. */
  readonly retryBackoffMs: number;
}

export interface SchedulerConfig {
  /** Per Persona × channel slot count. Default 1. Process-local only. */
  readonly perPersonaChannelConcurrency?: number;
  /** Global slot ceiling. Default 8, hard ceiling for this instance. */
  readonly maxConcurrentTotal?: number;
}

export type SchedulerState = 'created' | 'running' | 'stopping' | 'stopped';

export interface TaskHandlerContext {
  readonly runId: RunId;
  readonly logger: RuntimeLogger;
  /** Always `false`: running tasks are not cancellable (D-SCH3). */
  readonly signal: { readonly aborted: boolean };
}

export type TaskHandler = (task: TaskRow, context: TaskHandlerContext) => void | Promise<void>;

export interface SchedulerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  readonly policy: SchedulerPolicy;
  readonly handlers: ReadonlyMap<string, TaskHandler> | Readonly<Record<string, TaskHandler>>;
  readonly config?: SchedulerConfig;
  readonly now?: () => number;
  readonly timers?: SchedulerTimers;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface EnqueueTaskInput {
  readonly personaId: PersonaId;
  readonly kind: string;
  readonly channel: Channel;
  readonly priority?: number;
  readonly payloadRefs?: TaskPayloadRefs;
  readonly scheduledAt?: number | null;
}

export interface ScopedTaskRef {
  readonly personaId: PersonaId;
  readonly taskId: TaskId;
}

export interface TickReport {
  readonly personasVisited: number;
  readonly claimed: number;
  readonly dispatched: number;
}

export interface SchedulerStats {
  readonly state: SchedulerState;
  readonly activeHandlers: number;
  readonly activeUnits: number;
}

export interface TaskScheduler {
  readonly state: SchedulerState;
  /** CREATED → RUNNING. Throws `illegal_transition` from any other state. */
  start(): void;
  /** Asks the pump to run another tick. No-op unless `running`. */
  wake(): void;
  /** One-shot pump tick; joins an in-flight tick. Zero report unless `running`. */
  tick(): Promise<TickReport>;
  /** Stops claiming, waits for every in-flight handler to settle, releases the lease. */
  stop(): Promise<void>;
  enqueueTask(input: EnqueueTaskInput): Promise<TaskRow>;
  pauseTask(input: ScopedTaskRef): Promise<TaskRow>;
  resumeTask(input: ScopedTaskRef): Promise<TaskRow>;
  cancelTask(input: ScopedTaskRef): Promise<TaskRow>;
  stats(): SchedulerStats;
}

const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const DEFAULT_PER_UNIT = 1;
const DEFAULT_TOTAL = 8;
const PERSONA_PAGE_SIZE = 500;
const MAX_TIMER_DELAY = 2_147_483_647;
const ZERO_REPORT: TickReport = { personasVisited: 0, claimed: 0, dispatched: 0 };

interface ResolvedOptions {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  readonly policy: SchedulerPolicy;
  readonly handlers: ReadonlyMap<string, TaskHandler>;
  readonly perPersonaChannelConcurrency: number;
  readonly maxConcurrentTotal: number;
  readonly now: () => number;
  readonly timers: SchedulerTimers;
  readonly randomBytes?: (size: number) => Uint8Array;
}

function invalid(field: string, rule: string): never {
  throw new RuntimeError('invalid_argument', `${field} ${rule}`, { details: { field } });
}

function intInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(field, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function defaultTimers(): SchedulerTimers {
  return {
    setTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      // Do not hold the process open just for the next due wake-up.
      if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
        (handle as { unref(): void }).unref();
      }
      return handle;
    },
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function resolveOptions(options: SchedulerOptions): ResolvedOptions {
  if (typeof options !== 'object' || options === null) {
    invalid('options', 'must be an object');
  }
  if (options.store === undefined || options.store === null) {
    invalid('store', 'is required');
  }
  if (options.logger === undefined || options.logger === null) {
    invalid('logger', 'is required');
  }

  const policy = options.policy;
  if (typeof policy !== 'object' || policy === null) {
    invalid('policy', 'is required');
  }
  if (
    typeof policy.maxAttempts !== 'number' ||
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 100
  ) {
    invalid('policy.maxAttempts', 'must be an integer between 1 and 100');
  }
  if (
    typeof policy.retryBackoffMs !== 'number' ||
    !Number.isSafeInteger(policy.retryBackoffMs) ||
    policy.retryBackoffMs < 0 ||
    policy.retryBackoffMs > 86_400_000
  ) {
    invalid('policy.retryBackoffMs', 'must be a safe integer between 0 and 86400000');
  }

  const config = options.config ?? {};
  if (typeof config !== 'object' || config === null) {
    invalid('config', 'must be an object');
  }
  const perPersonaChannelConcurrency = intInRange(
    config.perPersonaChannelConcurrency,
    'config.perPersonaChannelConcurrency',
    1,
    64,
    DEFAULT_PER_UNIT,
  );
  const maxConcurrentTotal = intInRange(
    config.maxConcurrentTotal,
    'config.maxConcurrentTotal',
    1,
    1024,
    DEFAULT_TOTAL,
  );

  const handlers = resolveHandlers(options.handlers);

  const now = options.now ?? Date.now;
  if (typeof now !== 'function') {
    invalid('now', 'must be a function');
  }
  readClock(now);

  let timers = defaultTimers();
  if (options.timers !== undefined) {
    const candidate = options.timers;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.setTimeout !== 'function' ||
      typeof candidate.clearTimeout !== 'function'
    ) {
      invalid('timers', 'must provide setTimeout and clearTimeout');
    }
    timers = candidate;
  }

  const randomBytes = options.randomBytes;
  if (randomBytes !== undefined && typeof randomBytes !== 'function') {
    invalid('randomBytes', 'must be a function');
  }

  return {
    store: options.store,
    logger: options.logger,
    policy: { maxAttempts: policy.maxAttempts, retryBackoffMs: policy.retryBackoffMs },
    handlers,
    perPersonaChannelConcurrency,
    maxConcurrentTotal,
    now,
    timers,
    ...(randomBytes === undefined ? {} : { randomBytes }),
  };
}

function resolveHandlers(input: SchedulerOptions['handlers']): ReadonlyMap<string, TaskHandler> {
  if (input === undefined || input === null) {
    invalid('handlers', 'is required');
  }
  const result = new Map<string, TaskHandler>();
  const entries: Iterable<[string, unknown]> =
    input instanceof Map ? input.entries() : Object.entries(input ?? {});
  for (const [kind, handler] of entries) {
    if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) {
      invalid('handlers key', 'must match ^[a-z][a-z0-9._-]{0,63}$');
    }
    if (typeof handler !== 'function') {
      invalid(`handlers.${kind}`, 'must be a function');
    }
    result.set(kind, handler as TaskHandler);
  }
  return result;
}

function errorCode(error: unknown): string {
  if (isRuntimeError(error)) {
    return error.code;
  }
  if (isPersistenceError(error)) {
    return error.code;
  }
  return 'unknown';
}

/** Never lets diagnostics change scheduler behaviour. */
function safeLog(
  logger: RuntimeLogger,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  try {
    logger[level](event, fields);
  } catch {
    // Ignore logger failures.
  }
}

export function createScheduler(options: SchedulerOptions): TaskScheduler {
  const cfg = resolveOptions(options);
  const repos = createRepositories(cfg.store);
  const clock = (): number => readClock(cfg.now);

  // P8: take the Store lease before the instance exists. Validation ran above,
  // so a rejected configuration never takes or leaks the lease.
  const releaseLease = acquireStoreLease(cfg.store, 'scheduler');

  const handlers = cfg.handlers;
  const kinds = [...handlers.keys()];
  const signal = Object.freeze({ aborted: false });

  let state: SchedulerState = 'created';
  let stopPromise: Promise<void> | null = null;
  let tickInFlight: Promise<TickReport> | null = null;
  let rotation = 0;

  let activeTotal = 0;
  const activeUnits = new Map<string, number>();
  const inflight = new Set<Inflight>();

  let pendingWake = false;
  let pumpRunning = false;
  let dueTimer: unknown = undefined;
  let settleTimer: unknown = undefined;
  let wake: () => void = () => undefined;
  let leaseReleased = false;

  interface Inflight {
    readonly personaId: PersonaId;
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly attempt: number;
    readonly task: TaskRow;
  }

  const unitKey = (personaId: PersonaId, channel: Channel): string => `${personaId}|${channel}`;

  const releaseOne = (entry: Inflight): void => {
    activeTotal -= 1;
    if (activeTotal < 0) {
      activeTotal = 0;
    }
    const key = unitKey(entry.personaId, entry.task.channel);
    const current = activeUnits.get(key) ?? 0;
    if (current <= 1) {
      activeUnits.delete(key);
    } else {
      activeUnits.set(key, current - 1);
    }
  };

  const SETTLE_RETRY_BASE_MS = 25;
  const SETTLE_RETRY_MAX_MS = 5_000;
  const SETTLE_PENDING_LIMIT = 1_024;

  interface PendingSettle {
    readonly personaId: PersonaId;
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly attempt: number;
    readonly op: 'complete' | 'fail';
    finishedAt: number | null;
    nextScheduledAt: number | null;
    attempts: number;
    lastCode: string;
  }

  const pendingSettles = new Map<string, PendingSettle>();
  let settleBackpressured = false;

  const settleRetryDelay = (attempts: number): number => {
    const shift = Math.min(attempts, 8);
    return Math.min(SETTLE_RETRY_MAX_MS, SETTLE_RETRY_BASE_MS * 2 ** shift);
  };

  const readSettleClock = (): number | null => {
    try {
      return clock();
    } catch (error) {
      safeLog(cfg.logger, 'error', 'scheduler_clock_failed', { code: errorCode(error) });
      return null;
    }
  };

  const scheduleSettleRetry = (): void => {
    if (state !== 'running' || pendingSettles.size === 0 || settleTimer !== undefined) {
      return;
    }
    let attempts = 0;
    for (const item of pendingSettles.values()) {
      if (item.attempts > attempts) {
        attempts = item.attempts;
      }
    }
    try {
      settleTimer = cfg.timers.setTimeout(() => {
        settleTimer = undefined;
        if (state !== 'running') {
          return;
        }
        flushPendingSettles();
      }, settleRetryDelay(attempts));
    } catch (error) {
      // The pending row stays. The next tick, and stop(), try the write again.
      settleTimer = undefined;
      safeLog(cfg.logger, 'error', 'scheduler_timer_failed', { code: errorCode(error) });
    }
  };

  const applyPending = (item: PendingSettle): 'applied' | 'conflict' | 'failed' => {
    let finishedAt = item.finishedAt;
    if (finishedAt === null) {
      finishedAt = readSettleClock();
      if (finishedAt === null) {
        item.lastCode = 'clock_failed';
        return 'failed';
      }
      item.finishedAt = finishedAt;
      if (item.op === 'fail') {
        item.nextScheduledAt = finishedAt + cfg.policy.retryBackoffMs;
      }
    }
    try {
      if (item.op === 'complete') {
        const updated = repos.tasks.completeTask({
          id: item.taskId,
          personaId: item.personaId,
          runId: item.runId,
          expectedAttempt: item.attempt,
          finishedAt,
        });
        return updated === null ? 'conflict' : 'applied';
      }
      const nextScheduledAt = item.nextScheduledAt ?? finishedAt + cfg.policy.retryBackoffMs;
      item.nextScheduledAt = nextScheduledAt;
      const failed = repos.tasks.failTask({
        id: item.taskId,
        personaId: item.personaId,
        runId: item.runId,
        expectedAttempt: item.attempt,
        maxAttempts: cfg.policy.maxAttempts,
        retry: true,
        finishedAt,
        nextScheduledAt,
      });
      return failed === null ? 'conflict' : 'applied';
    } catch (error) {
      item.lastCode = errorCode(error);
      return 'failed';
    }
  };

  const flushPendingSettles = (): void => {
    if (state === 'stopped') {
      return;
    }
    for (const item of [...pendingSettles.values()]) {
      const outcome = applyPending(item);
      if (outcome === 'applied') {
        pendingSettles.delete(item.taskId);
        safeLog(cfg.logger, 'info', 'scheduler_settle_recovered', {
          personaId: item.personaId,
          taskId: item.taskId,
          attempt: item.attempt,
        });
        if (item.op === 'fail') {
          wake();
        }
      } else if (outcome === 'conflict') {
        pendingSettles.delete(item.taskId);
        safeLog(cfg.logger, 'warn', 'scheduler_settle_conflict', {
          personaId: item.personaId,
          taskId: item.taskId,
          attempt: item.attempt,
          code: 'concurrent_modification',
        });
      } else {
        item.attempts += 1;
      }
    }
    if (pendingSettles.size < SETTLE_PENDING_LIMIT) {
      settleBackpressured = false;
    }
    if (pendingSettles.size > 0 && state === 'running') {
      scheduleSettleRetry();
    }
  };

  const rememberSettle = (item: PendingSettle): void => {
    pendingSettles.set(item.taskId, item);
    safeLog(cfg.logger, 'error', 'scheduler_settle_failed', {
      personaId: item.personaId,
      taskId: item.taskId,
      attempt: item.attempt,
      code: item.lastCode,
    });
    scheduleSettleRetry();
  };

  const settleFailure = (entry: Inflight, error: unknown): void => {
    if (state === 'stopped') {
      safeLog(cfg.logger, 'warn', 'scheduler_late_result_discarded', {
        taskId: entry.taskId,
      });
      return;
    }
    safeLog(cfg.logger, 'warn', 'scheduler_handler_failed', {
      personaId: entry.personaId,
      taskId: entry.taskId,
      attempt: entry.attempt,
      code: errorCode(error),
    });
    const finishedAt = readSettleClock();
    if (finishedAt === null) {
      rememberSettle({
        personaId: entry.personaId,
        taskId: entry.taskId,
        runId: entry.runId,
        attempt: entry.attempt,
        op: 'fail',
        finishedAt: null,
        nextScheduledAt: null,
        attempts: 0,
        lastCode: 'clock_failed',
      });
      return;
    }
    try {
      const failed = repos.tasks.failTask({
        id: entry.taskId,
        personaId: entry.personaId,
        runId: entry.runId,
        expectedAttempt: entry.attempt,
        maxAttempts: cfg.policy.maxAttempts,
        retry: true,
        finishedAt,
        nextScheduledAt: finishedAt + cfg.policy.retryBackoffMs,
      });
      if (failed === null) {
        // CAS miss: the row moved on. Report it, never write an unconditional
        // fallback and never retry this failure blindly.
        safeLog(cfg.logger, 'warn', 'scheduler_settle_conflict', {
          personaId: entry.personaId,
          taskId: entry.taskId,
          attempt: entry.attempt,
          code: 'concurrent_modification',
        });
      }
    } catch (settleError) {
      // Keep the real row. Retry the same fail CAS; do not run the handler again.
      rememberSettle({
        personaId: entry.personaId,
        taskId: entry.taskId,
        runId: entry.runId,
        attempt: entry.attempt,
        op: 'fail',
        finishedAt,
        nextScheduledAt: finishedAt + cfg.policy.retryBackoffMs,
        attempts: 0,
        lastCode: errorCode(settleError),
      });
    }
  };

  const settleSuccess = (entry: Inflight): void => {
    if (state === 'stopped') {
      safeLog(cfg.logger, 'warn', 'scheduler_late_result_discarded', {
        taskId: entry.taskId,
      });
      return;
    }
    const finishedAt = readSettleClock();
    if (finishedAt === null) {
      // The handler succeeded. Do not classify that as a handler failure.
      rememberSettle({
        personaId: entry.personaId,
        taskId: entry.taskId,
        runId: entry.runId,
        attempt: entry.attempt,
        op: 'complete',
        finishedAt: null,
        nextScheduledAt: null,
        attempts: 0,
        lastCode: 'clock_failed',
      });
      return;
    }
    try {
      const updated = repos.tasks.completeTask({
        id: entry.taskId,
        personaId: entry.personaId,
        runId: entry.runId,
        expectedAttempt: entry.attempt,
        finishedAt,
      });
      if (updated === null) {
        safeLog(cfg.logger, 'warn', 'scheduler_settle_conflict', {
          personaId: entry.personaId,
          taskId: entry.taskId,
          attempt: entry.attempt,
          code: 'concurrent_modification',
        });
      }
    } catch (error) {
      // Keep the real row. Retry the same complete CAS; do not run the handler again.
      rememberSettle({
        personaId: entry.personaId,
        taskId: entry.taskId,
        runId: entry.runId,
        attempt: entry.attempt,
        op: 'complete',
        finishedAt,
        nextScheduledAt: null,
        attempts: 0,
        lastCode: errorCode(error),
      });
    }
  };

  const dispatch = (task: TaskRow): void => {
    const runId = task.runId;
    // A claimed row always carries the run id written by `claimNext`.
    if (runId === null || !isRunId(runId)) {
      safeLog(cfg.logger, 'error', 'scheduler_invalid_claim', { taskId: task.id });
      return;
    }
    const entry: Inflight = {
      personaId: task.personaId,
      taskId: task.id,
      runId,
      attempt: task.attempt,
      task,
    };
    activeTotal += 1;
    const key = unitKey(task.personaId, task.channel);
    activeUnits.set(key, (activeUnits.get(key) ?? 0) + 1);
    inflight.add(entry);

    const done = (async (): Promise<void> => {
      try {
        const handler = handlers.get(task.kind);
        if (handler === undefined) {
          // claimNext filters by registered kinds; this is a defensive guard.
          safeLog(cfg.logger, 'error', 'scheduler_unhandled_kind', { taskId: task.id });
          return;
        }
        await handler(task, { runId, logger: cfg.logger, signal });
        settleSuccess(entry);
      } catch (error) {
        settleFailure(entry, error);
      } finally {
        releaseOne(entry);
        inflight.delete(entry);
        if (state === 'running') {
          scheduleDueTimer();
          wake();
        }
      }
    })();
    entryDone.set(entry, done);
  };

  const entryDone = new WeakMap<Inflight, Promise<void>>();

  const claimOne = (personaId: PersonaId, channel: Channel): TaskRow | null => {
    const now = clock();
    const runId = allocateRunId({
      now: () => now,
      ...(cfg.randomBytes === undefined ? {} : { randomBytes: cfg.randomBytes }),
    });
    return repos.tasks.claimNext({
      personaId,
      channel,
      now,
      runId,
      maxAttempts: cfg.policy.maxAttempts,
      kinds,
    });
  };

  const listRunningPersonas = (): readonly PersonaRow[] => {
    const running: PersonaRow[] = [];
    let afterId: PersonaId | undefined;
    for (;;) {
      const page = repos.personas.listPage({
        limit: PERSONA_PAGE_SIZE,
        ...(afterId === undefined ? {} : { afterId }),
      });
      for (const persona of page) {
        if (persona.state === 'RUNNING') {
          running.push(persona);
        }
      }
      if (page.length < PERSONA_PAGE_SIZE) {
        return running;
      }
      const last = page[page.length - 1];
      if (last === undefined) {
        return running;
      }
      afterId = last.id;
    }
  };

  const clearDueTimer = (): void => {
    if (dueTimer === undefined) {
      return;
    }
    try {
      cfg.timers.clearTimeout(dueTimer);
    } catch {
      // A broken timer implementation must not corrupt scheduler state.
    }
    dueTimer = undefined;
  };

  const clearSettleTimer = (): void => {
    if (settleTimer === undefined) {
      return;
    }
    try {
      cfg.timers.clearTimeout(settleTimer);
    } catch {
      // A broken timer implementation must not corrupt scheduler state.
    }
    settleTimer = undefined;
  };

  const scheduleDueTimer = (): void => {
    clearDueTimer();
    if (state !== 'running') {
      return;
    }
    try {
      const now = clock();
      const due = repos.tasks.nextDueAt({ after: now });
      if (due === null) {
        return;
      }
      const delay = Math.min(Math.max(0, due - now), MAX_TIMER_DELAY);
      dueTimer = cfg.timers.setTimeout(() => {
        dueTimer = undefined;
        if (state === 'running') {
          wake();
        }
      }, delay);
    } catch (error) {
      safeLog(cfg.logger, 'error', 'scheduler_timer_failed', { code: errorCode(error) });
    }
  };

  const runTick = (): TickReport => {
    if (state !== 'running') {
      return ZERO_REPORT;
    }
    flushPendingSettles();
    if (kinds.length === 0) {
      scheduleDueTimer();
      return ZERO_REPORT;
    }
    const personas = listRunningPersonas();
    if (personas.length === 0) {
      scheduleDueTimer();
      return ZERO_REPORT;
    }

    const units: Array<{ personaId: PersonaId; channel: Channel }> = [];
    for (const persona of personas) {
      for (const channel of CHANNELS) {
        units.push({ personaId: persona.id, channel });
      }
    }
    const start = rotation % units.length;
    const ordered = units.slice(start).concat(units.slice(0, start));
    rotation = (start + 1) % units.length;

    let claimed = 0;
    for (;;) {
      if (state !== 'running') {
        break;
      }
      let claimedThisPass = 0;
      for (const unit of ordered) {
        if (state !== 'running' || activeTotal >= cfg.maxConcurrentTotal) {
          break;
        }
        const key = unitKey(unit.personaId, unit.channel);
        if ((activeUnits.get(key) ?? 0) >= cfg.perPersonaChannelConcurrency) {
          continue;
        }
        if (pendingSettles.size >= SETTLE_PENDING_LIMIT) {
          if (!settleBackpressured) {
            settleBackpressured = true;
            safeLog(cfg.logger, 'warn', 'scheduler_settle_backpressure', {
              pending: pendingSettles.size,
            });
          }
          break;
        }
        const task = claimOne(unit.personaId, unit.channel);
        if (task === null) {
          continue;
        }
        claimed += 1;
        claimedThisPass += 1;
        dispatch(task);
      }
      if (claimedThisPass === 0 || activeTotal >= cfg.maxConcurrentTotal) {
        break;
      }
    }

    scheduleDueTimer();
    return { personasVisited: personas.length, claimed, dispatched: claimed };
  };

  const tick = (): Promise<TickReport> => {
    if (state !== 'running') {
      return Promise.resolve(ZERO_REPORT);
    }
    if (tickInFlight !== null) {
      return tickInFlight;
    }
    const running = Promise.resolve().then(() => runTick());
    tickInFlight = running.finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  };

  const pump = async (): Promise<void> => {
    try {
      while (state === 'running' && pendingWake) {
        pendingWake = false;
        try {
          await tick();
        } catch (error) {
          safeLog(cfg.logger, 'error', 'scheduler_tick_failed', { code: errorCode(error) });
        }
      }
    } finally {
      pumpRunning = false;
      if (state === 'running' && pendingWake) {
        wake();
      }
    }
  };

  wake = (): void => {
    if (state !== 'running') {
      return;
    }
    pendingWake = true;
    if (!pumpRunning) {
      pumpRunning = true;
      void pump();
    }
  };

  const releaseLeaseOnce = (): void => {
    if (leaseReleased) {
      return;
    }
    leaseReleased = true;
    releaseLease();
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) {
      return stopPromise;
    }
    if (state === 'stopped') {
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    if (state === 'created') {
      state = 'stopped';
      clearDueTimer();
      releaseLeaseOnce();
      stopPromise = Promise.resolve();
      safeLog(cfg.logger, 'info', 'scheduler_stopped', { drained: true });
      return stopPromise;
    }

    state = 'stopping';
    clearDueTimer();
    safeLog(cfg.logger, 'info', 'scheduler_stopping', {});

    stopPromise = (async (): Promise<void> => {
      if (tickInFlight !== null) {
        try {
          await tickInFlight;
        } catch {
          // A failed tick must not block shutdown.
        }
      }
      // Wait for every dispatched handler to settle; a handler that never
      // resolves keeps stop pending (P5: stop may wait forever).
      while (inflight.size > 0) {
        const pending: Promise<void>[] = [];
        for (const entry of inflight) {
          const done = entryDone.get(entry);
          if (done !== undefined) {
            pending.push(done);
          }
        }
        if (pending.length === 0) {
          break;
        }
        await Promise.allSettled(pending);
      }
      clearDueTimer();
      clearSettleTimer();
      flushPendingSettles();
      if (pendingSettles.size > 0) {
        for (const item of pendingSettles.values()) {
          safeLog(cfg.logger, 'error', 'scheduler_settle_abandoned', {
            personaId: item.personaId,
            taskId: item.taskId,
            attempt: item.attempt,
            code: item.lastCode,
          });
        }
        pendingSettles.clear();
      }
      state = 'stopped';
      releaseLeaseOnce();
      safeLog(cfg.logger, 'info', 'scheduler_stopped', { drained: true });
    })();
    return stopPromise;
  };

  const assertNotStopped = (operation: string): void => {
    if (state === 'stopped') {
      throw new RuntimeError(
        'illegal_transition',
        `scheduler is stopped; ${operation} is not allowed`,
        {
          details: { operation },
        },
      );
    }
  };

  const readTask = (input: ScopedTaskRef): TaskRow | null =>
    repos.tasks.getById({ personaId: input.personaId, id: input.taskId });

  const enqueueTask = async (input: EnqueueTaskInput): Promise<TaskRow> => {
    assertNotStopped('enqueueTask');
    // P1: a task whose kind has no handler could never be claimed; reject it
    // before allocating an id or touching the database.
    if (typeof input.kind !== 'string' || !handlers.has(input.kind)) {
      throw new RuntimeError('invalid_argument', 'kind has no registered handler', {
        details: { operation: 'enqueueTask' },
      });
    }
    const taskId = allocateTaskId({
      now: () => clock(),
      isOccupied: (candidate) =>
        repos.tasks.getById({ personaId: input.personaId, id: candidate as TaskId }) !== null,
      ...(cfg.randomBytes === undefined ? {} : { randomBytes: cfg.randomBytes }),
    });
    const created = repos.tasks.insertQueuedTask({
      id: taskId,
      personaId: input.personaId,
      kind: input.kind,
      channel: input.channel,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.payloadRefs === undefined ? {} : { payloadRefs: input.payloadRefs }),
      ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
    });
    wake();
    return created;
  };

  const pauseTask = async (input: ScopedTaskRef): Promise<TaskRow> => {
    assertNotStopped('pauseTask');
    const row = readTask(input);
    if (row === null) {
      throw new RuntimeError('not_found', 'task does not exist', {
        details: { taskId: input.taskId },
      });
    }
    if (row.state !== 'queued') {
      throw new RuntimeError('illegal_transition', 'only queued tasks can be paused', {
        details: { taskId: input.taskId },
      });
    }
    const updated = repos.tasks.setTaskState({
      id: input.taskId,
      personaId: input.personaId,
      expectedState: 'queued',
      nextState: 'paused',
      at: clock(),
    });
    if (updated === null) {
      throw new RuntimeError('illegal_transition', 'task changed while pausing', {
        details: { taskId: input.taskId },
      });
    }
    wake();
    return updated;
  };

  const cancelTask = async (input: ScopedTaskRef): Promise<TaskRow> => {
    assertNotStopped('cancelTask');
    const row = readTask(input);
    if (row === null) {
      throw new RuntimeError('not_found', 'task does not exist', {
        details: { taskId: input.taskId },
      });
    }
    if (row.state !== 'queued' && row.state !== 'paused') {
      // Running (or terminal) tasks cannot be cancelled (D-SCH3).
      throw new RuntimeError('illegal_transition', 'only queued or paused tasks can be cancelled', {
        details: { taskId: input.taskId },
      });
    }
    const expectedState = row.state;
    const updated = repos.tasks.setTaskState({
      id: input.taskId,
      personaId: input.personaId,
      expectedState,
      nextState: 'cancelled',
      at: clock(),
    });
    if (updated === null) {
      throw new RuntimeError('illegal_transition', 'task changed while cancelling', {
        details: { taskId: input.taskId },
      });
    }
    wake();
    return updated;
  };

  const classifyResume = (row: TaskRow): void => {
    if (!Number.isSafeInteger(row.attempt) || row.attempt < 0) {
      throw new RuntimeError(
        'illegal_task_row',
        'task attempt is not a valid non-negative integer',
        {
          details: { taskId: row.id },
        },
      );
    }
    if (row.attempt >= cfg.policy.maxAttempts) {
      throw new RuntimeError('task_exhausted', 'task has exhausted its attempts', {
        details: { taskId: row.id },
      });
    }
  };

  const resumeTask = async (input: ScopedTaskRef): Promise<TaskRow> => {
    assertNotStopped('resumeTask');
    const row = readTask(input);
    if (row === null) {
      throw new RuntimeError('not_found', 'task does not exist', {
        details: { taskId: input.taskId },
      });
    }
    if (row.state !== 'paused') {
      throw new RuntimeError('illegal_transition', 'only paused tasks can be resumed', {
        details: { taskId: input.taskId },
      });
    }
    classifyResume(row);

    const updated = repos.tasks.setTaskState({
      id: input.taskId,
      personaId: input.personaId,
      expectedState: 'paused',
      nextState: 'queued',
      at: clock(),
      maxAttempts: cfg.policy.maxAttempts,
    });
    if (updated === null) {
      // Re-read and classify by the same table; never report success on a miss.
      const current = readTask(input);
      if (current === null) {
        throw new RuntimeError('not_found', 'task no longer exists', {
          details: { taskId: input.taskId },
        });
      }
      if (current.state !== 'paused') {
        throw new RuntimeError('illegal_transition', 'task changed while resuming', {
          details: { taskId: input.taskId },
        });
      }
      classifyResume(current);
      safeLog(cfg.logger, 'warn', 'resume_cas_inconsistency', { taskId: input.taskId });
      throw new RuntimeError('illegal_transition', 'resume did not win the CAS', {
        details: { taskId: input.taskId },
      });
    }
    wake();
    return updated;
  };

  const stats = (): SchedulerStats => ({
    state,
    activeHandlers: activeTotal,
    activeUnits: activeUnits.size,
  });

  safeLog(cfg.logger, 'info', 'scheduler_created', {
    handlers: kinds.length,
    perPersonaChannelConcurrency: cfg.perPersonaChannelConcurrency,
    maxConcurrentTotal: cfg.maxConcurrentTotal,
  });

  return {
    get state(): SchedulerState {
      return state;
    },
    start(): void {
      if (state !== 'created') {
        throw new RuntimeError('illegal_transition', 'scheduler can only start once', {
          details: { state },
        });
      }
      state = 'running';
      safeLog(cfg.logger, 'info', 'scheduler_started', { handlers: kinds.length });
      wake();
    },
    wake,
    tick,
    stop,
    enqueueTask,
    pauseTask,
    resumeTask,
    cancelTask,
    stats,
  };
}
