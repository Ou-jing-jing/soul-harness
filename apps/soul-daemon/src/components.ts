/**
 * RECOVERING assembly.
 *
 * Creates the persona lifecycle, normalizes crashed personas, and runs
 * `recoverRuntime`. Adapts the daemon logger and the millisecond clock, and
 * reuses the daemon's store, boot id, and frozen policy.
 *
 * No ingress, no scheduler, no handler map, no SQL, and no test-only budget
 * parameters. `maxScanQueries` and `maxProbeQueries` are intentionally absent:
 * recovery keeps the runtime defaults.
 */

import type { Store } from '@soul-harness/persistence';
import {
  createPersonaLifecycle,
  recoverRuntime,
  type PersonaLifecycle,
  type PersonaLifecycleOptions,
  type RecoveryReport,
  type RuntimeLogFields,
  type RuntimeLogger,
} from '@soul-harness/runtime';

import type { DaemonConfig } from './config.js';
import type { Logger } from './logger.js';

export function adaptRuntimeLogger(logger: Logger): RuntimeLogger {
  const forward =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (event: string, fields?: RuntimeLogFields): void => {
      logger[level](event, fields);
    };

  return {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  };
}

/**
 * Same adapter, except Runtime's own `recovery_incomplete` warning is dropped.
 * The daemon emits that event only when it has decided the boot result is
 * `recovery_incomplete`. A stop during the scan must not be logged as one.
 */
export function adaptRecoveryLogger(logger: Logger): RuntimeLogger {
  const adapted = adaptRuntimeLogger(logger);
  return {
    debug: adapted.debug,
    info: adapted.info,
    error: adapted.error,
    warn: (event, fields) => {
      if (event === 'recovery_incomplete') {
        return;
      }
      adapted.warn(event, fields);
    },
  };
}

/** Daemon clocks return `Date`. Runtime clocks return unix milliseconds. */
export function toRuntimeNow(clock: () => Date): () => number {
  return () => clock().getTime();
}

/**
 * The lock token is passed through unchanged. `createPersonaLifecycle` rejects
 * it via `isBootId` when it does not match; this cast does not mint a new id.
 */
function bootIdFromLock(token: string): PersonaLifecycleOptions['bootId'] {
  return token as PersonaLifecycleOptions['bootId'];
}

export interface PersonaRecoveryOutcome {
  readonly lifecycle: PersonaLifecycle;
  readonly normalized: number;
}

export async function runPersonaRecovery(input: {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  readonly bootId: string;
  readonly now: () => number;
}): Promise<PersonaRecoveryOutcome> {
  const lifecycle = createPersonaLifecycle({
    store: input.store,
    logger: input.logger,
    bootId: bootIdFromLock(input.bootId),
    now: input.now,
  });
  const changed = await lifecycle.normalizeCrashedPersonas();
  return { lifecycle, normalized: changed.length };
}

export function runRuntimeRecovery(input: {
  readonly store: Store;
  readonly logger: RuntimeLogger;
  /** The same frozen object E1 built for both Recovery and the Scheduler. */
  readonly policy: DaemonConfig['policy'];
  readonly now: () => number;
  readonly recovery: DaemonConfig['recovery'];
  readonly signal: AbortSignal;
}): Promise<RecoveryReport> {
  return recoverRuntime({
    store: input.store,
    logger: input.logger,
    policy: input.policy,
    now: input.now,
    batchSize: input.recovery.batchSize,
    maxRowsPerRun: input.recovery.maxRowsPerRun,
    maxPersonasPerRun: input.recovery.maxPersonasPerRun,
    signal: input.signal,
  });
}
