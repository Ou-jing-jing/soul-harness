/**
 * Daemon error model.
 *
 * A small closed set so the CLI can map failures to stable exit codes and the
 * tests can assert *why* a boot failed, rather than matching prose. Messages
 * never carry configuration values that could be secret (tokens, paths inside
 * private data) — they name the field, not its content.
 */

export const DAEMON_ERROR_CODES = [
  // configuration
  'config_missing',
  'config_invalid',
  // data directory
  'data_dir_invalid',
  'data_dir_unwritable',
  // single-instance lock
  'lock_held',
  'lock_unreadable',
  'lock_acquire_failed',
  'lock_release_failed',
  // lifecycle
  'startup_aborted',
  'startup_failed',
  // E2 raises the three recovery codes. E3 raises the bus and scheduler codes
  // when READY assembly fails. No shutdown-timeout code: stop is not forced.
  'persona_recovery_failed',
  'runtime_recovery_failed',
  'recovery_incomplete',
  'event_bus_start_failed',
  'scheduler_start_failed',
  'shutdown_failed',
  'invalid_transition',
] as const;

export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

export interface DaemonErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class DaemonError extends Error {
  readonly code: DaemonErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(code: DaemonErrorCode, message: string, options?: DaemonErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DaemonError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isDaemonError(value: unknown): value is DaemonError {
  return value instanceof DaemonError;
}
