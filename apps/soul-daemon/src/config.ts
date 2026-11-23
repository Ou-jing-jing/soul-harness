/**
 * Daemon configuration.
 *
 * Rules (PLAN §5, RUNTIME-LIFECYCLE §2 step 1, SH-008E §9):
 *   - every critical value is explicit; a missing data directory fails the boot
 *     instead of silently falling back to a temp directory
 *   - validation happens once, up front; the daemon receives a frozen config and
 *     never re-reads `process.env`
 *   - the config carries no secrets today, and any future secret must stay out of
 *     the structured log (see `logger.ts` redaction)
 *   - errors name the variable and its allowed range, never the value that was supplied
 */

import { resolve } from 'node:path';

import { DaemonError } from './errors.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONFIG_ENV_VARS = {
  dataDir: 'SOUL_DATA_DIR',
  logLevel: 'SOUL_LOG_LEVEL',
  shutdownTimeoutMs: 'SOUL_SHUTDOWN_TIMEOUT_MS',
  taskMaxAttempts: 'SOUL_TASK_MAX_ATTEMPTS',
  taskRetryBackoffMs: 'SOUL_TASK_RETRY_BACKOFF_MS',
  recoveryBatchSize: 'SOUL_RECOVERY_BATCH_SIZE',
  recoveryMaxRows: 'SOUL_RECOVERY_MAX_ROWS',
  recoveryMaxPersonas: 'SOUL_RECOVERY_MAX_PERSONAS',
  schedulerMaxTotal: 'SOUL_SCHEDULER_MAX_TOTAL',
  schedulerPerUnit: 'SOUL_SCHEDULER_PER_UNIT',
  ingressQueueCapacity: 'SOUL_INGRESS_QUEUE_CAPACITY',
  ingressBufferTtlMs: 'SOUL_INGRESS_BUFFER_TTL_MS',
  ingressPersonaCapacity: 'SOUL_INGRESS_PERSONA_CAPACITY',
} as const;

export const CONFIG_LIMITS = {
  shutdownTimeoutMs: { min: 100, max: 600_000, fallback: 10_000 },
  taskMaxAttempts: { min: 1, max: 100 },
  taskRetryBackoffMs: { min: 0, max: 86_400_000 },
  recoveryBatchSize: { min: 1, max: 500, fallback: 200 },
  recoveryMaxRows: { min: 1, max: 1_000_000, fallback: 10_000 },
  recoveryMaxPersonas: { min: 1, max: 10_000, fallback: 200 },
  schedulerMaxTotal: { min: 1, max: 1_024, fallback: 8 },
  schedulerPerUnit: { min: 1, max: 64, fallback: 1 },
  ingressQueueCapacity: { min: 1, max: 1_000_000, fallback: 256 },
  ingressBufferTtlMs: { min: 1, max: 86_400_000, fallback: 300_000 },
  ingressPersonaCapacity: { min: 1, max: 1_024, fallback: 8 },
} as const;

/**
 * The two fields Runtime's `RecoveryPolicy` and `SchedulerPolicy` both require.
 *
 * Checked against the exports on `d6048ba`: both interfaces are exactly
 * `{ maxAttempts, retryBackoffMs }`, and both factories only read those fields
 * before copying them. One frozen object of this shape can be passed to both.
 * This package does not import `@soul-harness/runtime`.
 */
export interface TaskPolicy {
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface RecoveryConfig {
  readonly batchSize: number;
  readonly maxRowsPerRun: number;
  readonly maxPersonasPerRun: number;
}

export interface SchedulerConfig {
  readonly maxConcurrentTotal: number;
  readonly perPersonaChannelConcurrency: number;
}

export interface IngressConfig {
  readonly queueCapacity: number;
  readonly bufferTtlMs: number;
  readonly personaAdmissionCapacity: number;
}

export interface DaemonConfig {
  /** Absolute path of the data directory; the instance lock is scoped to it. */
  readonly dataDir: string;
  readonly logLevel: LogLevel;
  /**
   * Parsed and stored only. E1 does not give this a shutdown meaning: it must
   * not abort `scheduler.stop()` or close the Store early.
   */
  readonly shutdownTimeoutMs: number;
  readonly policy: TaskPolicy;
  readonly recovery: RecoveryConfig;
  readonly scheduler: SchedulerConfig;
  readonly ingress: IngressConfig;
}

interface IntBound {
  readonly min: number;
  readonly max: number;
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function invalidInt(name: string, bound: IntBound): never {
  throw new DaemonError(
    'config_invalid',
    `${name} must be a safe integer between ${bound.min} and ${bound.max}`,
    { details: { variable: name, min: bound.min, max: bound.max } },
  );
}

function missingInt(name: string, bound: IntBound): never {
  throw new DaemonError('config_missing', `${name} is required`, {
    details: { variable: name, min: bound.min, max: bound.max },
  });
}

/** Digits only, so decimals, exponents and signs cannot pass as integers. */
function parseBoundedInt(raw: string, name: string, bound: IntBound): number {
  if (!/^\d+$/.test(raw)) {
    return invalidInt(name, bound);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < bound.min || parsed > bound.max) {
    return invalidInt(name, bound);
  }
  return parsed;
}

function readRequiredInt(env: NodeJS.ProcessEnv, name: string, bound: IntBound): number {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    return missingInt(name, bound);
  }
  return parseBoundedInt(raw, name, bound);
}

function readOptionalInt(
  env: NodeJS.ProcessEnv,
  name: string,
  bound: IntBound & { readonly fallback: number },
): number {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    return bound.fallback;
  }
  return parseBoundedInt(raw, name, bound);
}

/** Parses and validates the daemon configuration from the environment. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DaemonConfig {
  const rawDataDir = readRaw(env, CONFIG_ENV_VARS.dataDir);
  if (rawDataDir === undefined) {
    throw new DaemonError(
      'config_missing',
      `${CONFIG_ENV_VARS.dataDir} is required; the daemon never falls back to a temp directory`,
      { details: { variable: CONFIG_ENV_VARS.dataDir } },
    );
  }

  const dataDir = resolve(cwd, rawDataDir);

  const rawLogLevel = readRaw(env, CONFIG_ENV_VARS.logLevel);
  const logLevel: LogLevel = rawLogLevel === undefined ? 'info' : (rawLogLevel as LogLevel);
  if (rawLogLevel !== undefined && !LOG_LEVELS.includes(logLevel)) {
    throw new DaemonError(
      'config_invalid',
      `${CONFIG_ENV_VARS.logLevel} must be one of the documented levels`,
      {
        details: { variable: CONFIG_ENV_VARS.logLevel },
      },
    );
  }

  const shutdownTimeoutMs = readOptionalInt(
    env,
    CONFIG_ENV_VARS.shutdownTimeoutMs,
    CONFIG_LIMITS.shutdownTimeoutMs,
  );

  const policy: TaskPolicy = Object.freeze({
    maxAttempts: readRequiredInt(
      env,
      CONFIG_ENV_VARS.taskMaxAttempts,
      CONFIG_LIMITS.taskMaxAttempts,
    ),
    retryBackoffMs: readRequiredInt(
      env,
      CONFIG_ENV_VARS.taskRetryBackoffMs,
      CONFIG_LIMITS.taskRetryBackoffMs,
    ),
  });

  const recovery: RecoveryConfig = Object.freeze({
    batchSize: readOptionalInt(
      env,
      CONFIG_ENV_VARS.recoveryBatchSize,
      CONFIG_LIMITS.recoveryBatchSize,
    ),
    maxRowsPerRun: readOptionalInt(
      env,
      CONFIG_ENV_VARS.recoveryMaxRows,
      CONFIG_LIMITS.recoveryMaxRows,
    ),
    maxPersonasPerRun: readOptionalInt(
      env,
      CONFIG_ENV_VARS.recoveryMaxPersonas,
      CONFIG_LIMITS.recoveryMaxPersonas,
    ),
  });

  const scheduler: SchedulerConfig = Object.freeze({
    maxConcurrentTotal: readOptionalInt(
      env,
      CONFIG_ENV_VARS.schedulerMaxTotal,
      CONFIG_LIMITS.schedulerMaxTotal,
    ),
    perPersonaChannelConcurrency: readOptionalInt(
      env,
      CONFIG_ENV_VARS.schedulerPerUnit,
      CONFIG_LIMITS.schedulerPerUnit,
    ),
  });

  const ingress: IngressConfig = Object.freeze({
    queueCapacity: readOptionalInt(
      env,
      CONFIG_ENV_VARS.ingressQueueCapacity,
      CONFIG_LIMITS.ingressQueueCapacity,
    ),
    bufferTtlMs: readOptionalInt(
      env,
      CONFIG_ENV_VARS.ingressBufferTtlMs,
      CONFIG_LIMITS.ingressBufferTtlMs,
    ),
    personaAdmissionCapacity: readOptionalInt(
      env,
      CONFIG_ENV_VARS.ingressPersonaCapacity,
      CONFIG_LIMITS.ingressPersonaCapacity,
    ),
  });

  return Object.freeze({
    dataDir,
    logLevel,
    shutdownTimeoutMs,
    policy,
    recovery,
    scheduler,
    ingress,
  });
}
