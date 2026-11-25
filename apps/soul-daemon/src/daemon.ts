/**
 * Daemon lifecycle.
 *
 * Implements the infrastructure half of RUNTIME-LIFECYCLE §2/§3 and nothing else:
 *
 *   BOOTING → MIGRATING → RECOVERING → READY → RUNNING
 *   RUNNING → DRAINING → CLOSING → STOPPED
 *
 * Checkpoint is not a phase this process enters. The step is logged as
 * `checkpoint_skipped` and nothing is written.
 *
 * What is real: configuration, structured logging, data-directory probe, the
 * single-instance lock, opening SQLite, running migrations, verifying the
 * schema, normalizing crashed personas, `recoverRuntime`, an in-process
 * ingress with no transport, and a scheduler with an empty handler map. What
 * is **not** real yet: external input, task dispatch, HTTP/WebSocket and the
 * health transport. Recovery must finish completely before those later
 * components are created.
 *
 * Resource discipline: ingress is closed first, then `scheduler.stop()` is
 * awaited, and only then is the store closed and the instance lock released.
 * `SOUL_SHUTDOWN_TIMEOUT_MS` is not a deadline. Cleanup failures are collected
 * and reported instead of being swallowed. A broken cleanup must never look
 * like a clean shutdown. If `scheduler.stop()` rejects, the store stays open
 * and the lock stays held. If `Store.close()` throws, the instance lock is
 * not released (D-E4-LOCK-1), including on a later cleanup pass. The next
 * start takes the stale lock.
 */

import { join } from 'node:path';

import { migrate, openStore, verifySchema, type Store } from '@soul-harness/persistence';
import type { SchedulerStats } from '@soul-harness/runtime';

import type { DaemonConfig } from './config.js';
import {
  adaptRecoveryLogger,
  adaptRuntimeLogger,
  createDaemonIngress,
  createDaemonScheduler,
  runPersonaRecovery,
  runRuntimeRecovery,
  toRuntimeNow,
  type PersonaRecoveryOutcome,
} from './components.js';
import { ensureDataDir } from './data-dir.js';
import { DaemonError, isDaemonError } from './errors.js';
import { acquireInstanceLock, type InstanceLock } from './lock.js';
import type { Logger } from './logger.js';
import { loadOrCreateApiToken, type ApiTokenVerifier } from './api/token.js';
import {
  CURRENT_RUNTIME_SURFACE,
  READY_TARGET_SURFACE,
  RECOVERED_RUNTIME_SURFACE,
  STARTUP_STEPS,
  type DaemonComponentSurface,
  type DaemonPhase,
  type DaemonRuntimeSurface,
  type LifecycleStep,
  type RuntimeCapabilitySurface,
} from './phases.js';

export interface DaemonOptions {
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

export interface StepOutcome {
  readonly step: string;
  readonly status: 'ok' | 'failed';
  readonly code?: string;
}

export interface DaemonRecoverySummary {
  readonly personasNormalized: number;
  readonly personasScanned: number;
  readonly tasksRequeued: number;
  readonly tasksFailed: number;
  readonly eventsExpired: number;
}

export interface StartReport {
  readonly phase: 'RUNNING';
  readonly pid: number;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly bootId: string;
  readonly appliedMigrations: readonly number[];
  readonly currentVersion: number;
  readonly skippedSteps: readonly string[];
  readonly recovery: DaemonRecoverySummary;
  readonly components: DaemonComponentSurface;
  readonly capabilities: RuntimeCapabilitySurface;
}

export interface StopReport {
  readonly phase: 'STOPPED';
  readonly reason: string;
  readonly steps: readonly StepOutcome[];
}

export interface DaemonStatus {
  readonly phase: DaemonPhase;
  readonly pid: number;
  readonly dataDir: string;
  readonly startedAt: string | null;
  readonly bootId: string | null;
  readonly storeOpen: boolean;
  readonly lockHeld: boolean;
  readonly lockPath: string | null;
  readonly personaLifecycleAssembled: boolean;
  readonly recovery: DaemonRecoverySummary | null;
  readonly scheduler: SchedulerStats | null;
  readonly components: DaemonComponentSurface;
  readonly capabilities: RuntimeCapabilitySurface;
}

interface Resource {
  readonly step: string;
  readonly release: () => void;
  released: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => resolveFn?.(value),
    reject: (error) => rejectFn?.(error),
  };
}

/**
 * A close failure recorded on an earlier pass is not in this pass's steps.
 * The shutdown result still has to say `sqlite_open` failed.
 */
function withStoreCloseFailure(
  steps: readonly StepOutcome[],
  storeCloseFailed: boolean,
): StepOutcome[] {
  if (!storeCloseFailed || steps.some((entry) => entry.step === 'sqlite_open')) {
    return [...steps];
  }
  return [...steps, { step: 'sqlite_open', status: 'failed', code: 'shutdown_failed' }];
}

export class SoulDaemon {
  readonly #config: DaemonConfig;
  readonly #logger: Logger;
  readonly #clock: () => Date;

  #phase: DaemonPhase = 'BOOTING';
  #resources: Resource[] = [];
  #lock: InstanceLock | null = null;
  #store: Store | null = null;
  #lifecycle: PersonaRecoveryOutcome['lifecycle'] | null = null;
  #apiToken: ApiTokenVerifier | null = null;
  #ingress: ReturnType<typeof createDaemonIngress> | null = null;
  #scheduler: ReturnType<typeof createDaemonScheduler> | null = null;
  #surface: DaemonRuntimeSurface = CURRENT_RUNTIME_SURFACE;
  #recovery: DaemonRecoverySummary | null = null;
  #recoveryAbort: AbortController | null = null;

  #startedAt: string | null = null;
  #stopRequested = false;
  #startPromise: Promise<StartReport> | null = null;
  #stopPromise: Promise<StopReport> | null = null;
  #lastStopReport: StopReport | null = null;
  #schedulerStopFailed = false;
  /** `Store.close()` threw. A later pass must not call `lock.release()`. */
  #storeCloseFailed = false;

  readonly #shutdownDone = createDeferred<StopReport>();

  constructor(options: DaemonOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#clock = options.clock ?? ((): Date => new Date());
    // A shutdown rejection is reported to whoever awaits `whenStopped()`; this
    // handler only prevents an unhandled-rejection crash when nobody does.
    this.#shutdownDone.promise.catch(() => undefined);
  }

  get phase(): DaemonPhase {
    return this.#phase;
  }

  get status(): DaemonStatus {
    return {
      phase: this.#phase,
      pid: process.pid,
      dataDir: this.#config.dataDir,
      startedAt: this.#startedAt,
      bootId: this.#lock?.holder.bootToken ?? null,
      storeOpen: this.#store !== null,
      lockHeld: this.#lock !== null,
      lockPath: this.#lock?.path ?? null,
      personaLifecycleAssembled: this.#lifecycle !== null,
      recovery: this.#recovery,
      scheduler: this.#scheduler?.stats() ?? null,
      components: this.#surface.components,
      capabilities: this.#surface.capabilities,
    };
  }

  /** E1 seam for a future API server; no token is exposed. */
  verifyApiToken(candidate: string): boolean {
    return this.#apiToken?.verify(candidate) ?? false;
  }

  /** Resolves once the daemon has fully stopped; rejects if cleanup failed. */
  whenStopped(): Promise<StopReport> {
    return this.#shutdownDone.promise;
  }

  start(): Promise<StartReport> {
    if (this.#startPromise === null) {
      this.#startPromise = this.#boot();
    }
    return this.#startPromise;
  }

  /**
   * Requests a stop. Idempotent: repeated calls return the same promise.
   * Safe to call while booting — the boot aborts at its next step boundary.
   */
  stop(reason: string = 'requested'): Promise<StopReport> {
    this.#stopRequested = true;
    // Recovery checks this signal only at a query or row boundary. A stop
    // requested inside the synchronous scan is not an instant preemption.
    this.#recoveryAbort?.abort();

    if (this.#stopPromise === null) {
      this.#stopPromise = (async (): Promise<StopReport> => {
        await this.#startPromise?.catch(() => undefined);
        return this.#shutdown(reason);
      })();
    }

    return this.#stopPromise;
  }

  async #boot(): Promise<StartReport> {
    const { dataDir } = this.#config;
    const skipped: string[] = [];

    this.#logger.info('boot_started', { dataDir, pid: process.pid });

    try {
      // 1. configuration (validated before construction; record the effective shape)
      this.#logger.info('step_ok', {
        step: 'config',
        logLevel: this.#config.logLevel,
        shutdownTimeoutMs: this.#config.shutdownTimeoutMs,
      });
      await this.#boundary();

      // 2. structured logging
      this.#logger.info('step_ok', { step: 'logging' });
      await this.#boundary();

      // 3. data directory + write probe
      ensureDataDir(dataDir);
      this.#logger.info('step_ok', { step: 'data_directory', dataDir });
      await this.#boundary();

      // 4. single-instance lock — before the database is touched
      const lock = acquireInstanceLock(dataDir);
      this.#lock = lock;
      this.#resources.push({
        step: 'instance_lock',
        release: () => lock.release(),
        released: false,
      });
      this.#logger.info('step_ok', {
        step: 'instance_lock',
        lockPath: lock.path,
        lockPid: lock.holder.pid,
      });
      await this.#boundary();

      // 5. local API token, before the database is touched. The token is only
      // retained as a verifier; it is never logged or returned.
      this.#apiToken = loadOrCreateApiToken(dataDir);

      // 6. SQLite
      const databaseFile = join(dataDir, 'soul.db');
      const store = openStore({ file: databaseFile });
      this.#store = store;
      this.#resources.push({ step: 'sqlite_open', release: () => store.close(), released: false });
      this.#logger.info('step_ok', { step: 'sqlite_open', databaseFile });
      await this.#boundary();

      // 7/8. migrations + schema verification
      this.#enter('MIGRATING');
      const migration = migrate(store);
      verifySchema(store);
      this.#logger.info('step_ok', {
        step: 'migrations',
        applied: migration.applied.length,
        currentVersion: migration.currentVersion,
      });
      this.#logger.info('step_ok', { step: 'schema_verification' });
      await this.#boundary();

      // 8/9. Persona normalize, then runtime recovery. Both must settle before
      // the store can close. No ingress and no scheduler are created here.
      this.#enter('RECOVERING');
      await this.#boundary();
      const recovery = await this.#recover(store, lock.holder.bootToken);
      await this.#boundary();

      // Ingress, then the scheduler. Neither exists unless recovery finished.
      // A stop at a boundary does not continue, and a failed create does not
      // leave the next component running.
      this.#enter('READY');
      await this.#assembleReady(store);
      this.#skipUnimplemented('READY', skipped);
      await this.#boundary();

      // Running. The scheduler is running and still has no handlers.
      this.#enter('RUNNING');
      this.#startedAt = this.#clock().toISOString();
      const surface = this.#surface;
      this.#logger.info('daemon_running', {
        dataDir,
        databaseFile,
        bootId: lock.holder.bootToken,
        personaLifecycle: surface.capabilities.personaLifecycle,
        runtimeRecovery: surface.capabilities.runtimeRecovery,
        eventBus: surface.capabilities.eventBus,
        eventIngress: surface.capabilities.eventIngress,
        scheduler: surface.capabilities.scheduler,
        taskDispatch: surface.capabilities.taskDispatch,
        httpApi: surface.capabilities.httpApi,
        healthEndpoint: surface.capabilities.healthEndpoint,
      });

      return {
        phase: 'RUNNING',
        pid: process.pid,
        dataDir,
        databaseFile,
        bootId: lock.holder.bootToken,
        appliedMigrations: migration.applied,
        currentVersion: migration.currentVersion,
        skippedSteps: skipped,
        recovery,
        components: surface.components,
        capabilities: surface.capabilities,
      };
    } catch (error) {
      const cleanup = await this.#releaseAll();
      this.#apiToken = null;
      this.#phase = 'FAILED';

      const code = isDaemonError(error) ? error.code : 'startup_failed';
      this.#logger.error('boot_failed', {
        code,
        cleanupFailures: cleanup.filter((entry) => entry.status === 'failed').length,
      });

      // A DaemonError already carries a precise code (lock_held, data_dir_invalid,
      // startup_aborted ?). Wrapping it would flatten every cause into exit code 5
      // and hide *why* the boot failed.
      if (isDaemonError(error)) {
        throw error;
      }
      throw new DaemonError('startup_failed', 'daemon failed to start', {
        cause: error,
        details: {
          code,
          cleanupFailures: cleanup.filter((entry) => entry.status === 'failed').length,
        },
      });
    }
  }

  async #shutdown(reason: string): Promise<StopReport> {
    if (this.#phase === 'STOPPED' && this.#lastStopReport !== null) {
      return this.#lastStopReport;
    }

    const ranForReal = this.#phase === 'RUNNING' || this.#phase === 'READY';

    if (ranForReal) {
      this.#enter('DRAINING');
      this.#logger.info('drain_started', { reason });
      // A scheduler that was actually started is stopped below. Saying the
      // drain is unimplemented after that would be a lie. The skip remains
      // only for a READY boundary that aborted before the scheduler existed.
      if (this.#scheduler === null) {
        this.#logger.info('step_skipped', {
          step: 'scheduler_drain',
          owner: 'SH-008',
          reason: 'not_implemented',
        });
      }
    }

    // Checkpointing is only legal when a runtime exists to produce one. Writing a
    // placeholder would fabricate state, so the step is reported as skipped.
    // There is no drain and no shutdown deadline.
    this.#logger.info('checkpoint_skipped', { reason: 'runtime_not_implemented' });

    const steps: StepOutcome[] = [];
    this.#closeIngress(steps);
    const schedulerFailed = await this.#stopScheduler(steps);
    if (schedulerFailed || this.#schedulerStopFailed) {
      // The scheduler may still be inside the store. Do not close it and do
      // not drop the lock just because stop rejected.
      throw this.#rejectShutdown(steps);
    }

    this.#enter('CLOSING');
    this.#releaseStoreAndLock(steps);

    this.#enter('STOPPED');
    const reported = withStoreCloseFailure(steps, this.#storeCloseFailed);
    const report: StopReport = { phase: 'STOPPED', reason, steps: reported };
    this.#lastStopReport = report;

    const failures = reported.filter((entry) => entry.status === 'failed');
    this.#logger.info('daemon_stopped', { reason, cleanupFailures: failures.length });

    if (failures.length > 0) {
      throw this.#rejectShutdown(reported);
    }

    this.#shutdownDone.resolve(report);
    return report;
  }

  async #releaseAll(): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = [];
    this.#closeIngress(outcomes);
    const schedulerFailed = await this.#stopScheduler(outcomes);
    if (!schedulerFailed && !this.#schedulerStopFailed) {
      this.#releaseStoreAndLock(outcomes);
    }
    return outcomes;
  }

  #closeIngress(outcomes: StepOutcome[]): void {
    const ingress = this.#ingress;
    this.#ingress = null;
    if (ingress === null) {
      return;
    }
    try {
      ingress.close();
      outcomes.push({ step: 'event_bus', status: 'ok' });
    } catch (error) {
      const code = isDaemonError(error) ? error.code : 'shutdown_failed';
      outcomes.push({ step: 'event_bus', status: 'failed', code });
      this.#logger.error('cleanup_failed', { step: 'event_bus', code });
    }
  }

  /** Resolves `true` when stop rejected. The store must then stay open. */
  async #stopScheduler(outcomes: StepOutcome[]): Promise<boolean> {
    const scheduler = this.#scheduler;
    this.#scheduler = null;
    if (scheduler === null) {
      return false;
    }
    try {
      await scheduler.stop();
      outcomes.push({ step: 'scheduler', status: 'ok' });
      return false;
    } catch (error) {
      const code = isDaemonError(error) ? error.code : 'shutdown_failed';
      outcomes.push({ step: 'scheduler', status: 'failed', code });
      this.#logger.error('cleanup_failed', { step: 'scheduler', code });
      this.#schedulerStopFailed = true;
      return true;
    }
  }

  /**
   * Store, then lock. A thrown `Store.close()` skips `lock.release()` so the
   * next process cannot open a file this process failed to close cleanly.
   */
  #releaseStoreAndLock(outcomes: StepOutcome[]): void {
    let storeCloseFailed = this.#storeCloseFailed;
    const retained: Resource[] = [];

    for (const resource of [...this.#resources].reverse()) {
      if (resource.released) {
        continue;
      }
      if (resource.step === 'instance_lock' && storeCloseFailed) {
        retained.push(resource);
        continue;
      }
      resource.released = true;

      try {
        resource.release();
        outcomes.push({ step: resource.step, status: 'ok' });
      } catch (error) {
        const code = isDaemonError(error) ? error.code : 'shutdown_failed';
        outcomes.push({ step: resource.step, status: 'failed', code });
        this.#logger.error('cleanup_failed', { step: resource.step, code });
        if (resource.step === 'sqlite_open') {
          storeCloseFailed = true;
          this.#storeCloseFailed = true;
        }
      }
    }

    this.#resources = retained;
    if (outcomes.some((entry) => entry.step === 'instance_lock' && entry.status === 'ok')) {
      this.#lock = null;
    }
    if (outcomes.some((entry) => entry.step === 'sqlite_open')) {
      this.#store = null;
      this.#lifecycle = null;
      this.#apiToken = null;
      this.#surface = CURRENT_RUNTIME_SURFACE;
    }
  }

  #rejectShutdown(steps: readonly StepOutcome[]): DaemonError {
    const failures = steps.filter((entry) => entry.status === 'failed');
    const error = new DaemonError('shutdown_failed', 'daemon stopped with cleanup failures', {
      details: { failures: failures.length, first: failures[0]?.step ?? 'unknown' },
    });
    this.#shutdownDone.reject(error);
    return error;
  }

  /**
   * Ingress, then scheduler. The surface is published only after `start()`.
   * Boundaries sit before each component so a stop does not continue.
   */
  async #assembleReady(store: Store): Promise<void> {
    const now = toRuntimeNow(this.#clock);
    const logger = adaptRuntimeLogger(this.#logger);

    await this.#boundary();

    try {
      this.#ingress = createDaemonIngress({
        store,
        logger,
        now,
        ingress: this.#config.ingress,
      });
    } catch (error) {
      this.#throwAssemblyFailure(error, 'event_bus_start_failed', 'event bus failed to start');
    }
    this.#logger.info('step_ok', { step: 'event_bus', transport: 'none', acceptsInput: false });
    await this.#boundary();

    let scheduler: ReturnType<typeof createDaemonScheduler>;
    try {
      scheduler = createDaemonScheduler({
        store,
        logger,
        policy: this.#config.policy,
        now,
        scheduler: this.#config.scheduler,
      });
    } catch (error) {
      this.#throwAssemblyFailure(error, 'scheduler_start_failed', 'scheduler failed to start');
    }
    this.#scheduler = scheduler;
    await this.#boundary();

    try {
      scheduler.start();
    } catch (error) {
      this.#throwAssemblyFailure(error, 'scheduler_start_failed', 'scheduler failed to start');
    }
    this.#surface = READY_TARGET_SURFACE;
    this.#logger.info('step_ok', {
      step: 'scheduler',
      state: 'running',
      handlerKinds: 0,
      dispatchesTasks: false,
    });
  }

  #throwAssemblyFailure(
    error: unknown,
    code: 'event_bus_start_failed' | 'scheduler_start_failed',
    message: string,
  ): never {
    if (this.#stopRequested) {
      throw new DaemonError('startup_aborted', 'stop requested while the daemon was booting');
    }
    if (isDaemonError(error)) {
      throw error;
    }
    this.#logger.error(code, { code });
    throw new DaemonError(code, message, { cause: error });
  }

  #skipUnimplemented(phase: 'READY', skipped: string[]): void {
    for (const step of STARTUP_STEPS.filter(
      (entry) => entry.phase === phase && entry.status === 'not_implemented',
    )) {
      skipped.push(step.id);
      this.#logSkipped(step);
    }
  }

  #logSkipped(step: LifecycleStep): void {
    this.#logger.info('step_skipped', {
      step: step.id,
      phase: step.phase,
      owner: step.owner ?? 'unassigned',
      reason: step.note,
      status: step.status,
    });
  }

  /**
   * Step boundary: yields to the event loop, then aborts if a stop was requested.
   *
   * The yield is what makes "stop during boot" real: signal handlers and
   * `stop()` calls run as macrotasks, so a boot that never yields could not be
   * interrupted even though the lifecycle promises it can.
   */
  async #boundary(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (this.#stopRequested) {
      throw new DaemonError('startup_aborted', 'stop requested while the daemon was booting');
    }
  }

  #enter(phase: DaemonPhase): void {
    this.#phase = phase;
    this.#logger.info('phase_entered', { phase });
  }

  /**
   * Persona normalize, then runtime recovery.
   *
   * A stop requested before the result is interpreted is `startup_aborted`,
   * never `recovery_incomplete`. The store stays open until this promise
   * settles; cleanup is the caller's job.
   */
  async #recover(store: Store, bootId: string): Promise<DaemonRecoverySummary> {
    const controller = new AbortController();
    this.#recoveryAbort = controller;
    if (this.#stopRequested) {
      controller.abort();
    }

    const now = toRuntimeNow(this.#clock);
    const logger = adaptRecoveryLogger(this.#logger);

    try {
      let normalized = 0;
      try {
        const persona = await runPersonaRecovery({ store, logger, bootId, now });
        this.#lifecycle = persona.lifecycle;
        normalized = persona.normalized;
      } catch (error) {
        this.#throwRecoveryFailure(error, 'persona_recovery_failed', 'persona recovery failed');
      }

      this.#logger.info('step_ok', { step: 'persona_recovery', normalized });

      if (this.#stopRequested) {
        controller.abort();
      }

      let report;
      try {
        report = await runRuntimeRecovery({
          store,
          logger,
          policy: this.#config.policy,
          now,
          recovery: this.#config.recovery,
          signal: controller.signal,
        });
      } catch (error) {
        this.#throwRecoveryFailure(error, 'runtime_recovery_failed', 'runtime recovery failed');
      }

      // Stop wins over an incomplete report produced while the signal aborted.
      if (this.#stopRequested) {
        throw new DaemonError('startup_aborted', 'stop requested while the daemon was booting');
      }

      if (report.incomplete !== null) {
        const reason = report.incomplete.reason;
        this.#logger.error('recovery_incomplete', {
          reason,
          personasScanned: report.personasScanned,
          tasksRequeued: report.tasks.requeued,
          tasksFailed: report.tasks.failed,
          eventsExpired: report.events.expired,
        });
        throw new DaemonError('recovery_incomplete', 'runtime recovery did not finish', {
          details: { reason },
        });
      }

      const summary: DaemonRecoverySummary = Object.freeze({
        personasNormalized: normalized,
        personasScanned: report.personasScanned,
        tasksRequeued: report.tasks.requeued,
        tasksFailed: report.tasks.failed,
        eventsExpired: report.events.expired,
      });
      this.#recovery = summary;
      this.#surface = RECOVERED_RUNTIME_SURFACE;
      this.#logger.info('step_ok', {
        step: 'runtime_recovery',
        personasScanned: summary.personasScanned,
        tasksRequeued: summary.tasksRequeued,
        tasksFailed: summary.tasksFailed,
        eventsExpired: summary.eventsExpired,
      });
      return summary;
    } finally {
      this.#recoveryAbort = null;
    }
  }

  #throwRecoveryFailure(
    error: unknown,
    code: 'persona_recovery_failed' | 'runtime_recovery_failed',
    message: string,
  ): never {
    if (this.#stopRequested) {
      throw new DaemonError('startup_aborted', 'stop requested while the daemon was booting');
    }
    if (isDaemonError(error)) {
      throw error;
    }
    if (code === 'runtime_recovery_failed') {
      this.#logger.error('runtime_recovery_failed', { code });
    } else {
      this.#logger.error('persona_recovery_failed', { code });
    }
    throw new DaemonError(code, message, { cause: error });
  }
}
