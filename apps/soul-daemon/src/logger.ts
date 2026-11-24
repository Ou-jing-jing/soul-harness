/**
 * Structured logging.
 *
 * One JSON object per line. Rules (RUNTIME-LIFECYCLE §2 step 2, TRUST-BOUNDARIES
 * §11.3): no event content, no memory content, no model input/output, no tokens
 * or keys — and no way to smuggle them in through an exception stack, a nested
 * object, or a field name the daemon does not use.
 *
 * Field names are default-deny. A key is written only when it is on the
 * operational allowlist; every other key is kept so the drop is visible, but
 * its value is replaced with `[redacted]` and not walked. Allowlisted keys
 * whose names still look like content (`token`, `content`, `payload`, …) are
 * redacted too.
 *
 * A matching name is not enough for a value that can come from outside the
 * process. `source` and `adapterId` stay redacted until the adapter registry
 * exists — a shape check is not that registry. `adapterEventRef` is written
 * only as a short hash. `reason` must be one of the fixed operational codes.
 * `event` must match the internal event-name shape; anything else is replaced
 * with `invalid_event` and the original text is dropped.
 *
 * `Error` objects are reduced to `{ name, code, message: '[redacted]' }`.
 * `Error.message` is untrusted free text, and a plain string field named
 * `message` is not allowlisted, so neither path writes it.
 */

import { createHash } from 'node:crypto';

import type { LogLevel } from './config.js';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Operational fields the daemon and the runtime actually emit.
 * Anything else is untrusted free text, whatever its key is called.
 */
const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  'acceptsInput',
  'adapterEventRef',
  'adapterId',
  'applied',
  'attempt',
  'batchSize',
  'bodyVerified',
  'bootId',
  'cleanupFailures',
  'code',
  'currentVersion',
  'dataDir',
  'databaseFile',
  'drained',
  'epoch',
  'error',
  'eventBus',
  'eventId',
  'eventIngress',
  'eventsExpired',
  'expectedVersion',
  'expired',
  'failed',
  'from',
  'handlers',
  'healthEndpoint',
  'httpApi',
  'lockPath',
  'lockPid',
  'logLevel',
  'maxAttempts',
  'maxConcurrentTotal',
  'maxPersonasPerRun',
  'maxProbeQueries',
  'maxRowsPerRun',
  'maxScanQueries',
  'metric',
  'normalized',
  'operation',
  'owner',
  'pending',
  'perPersonaChannelConcurrency',
  'personaAdmissionCapacity',
  'personaId',
  'personaLifecycle',
  'personaWaiting',
  'personas',
  'personasScanned',
  'phase',
  'pid',
  'probed',
  'probes',
  'queueCapacity',
  'reason',
  'receivedAt',
  'requeued',
  'runtimeRecovery',
  'scanned',
  'scheduler',
  'schema',
  'sessionId',
  'shutdownTimeoutMs',
  'signal',
  'source',
  'sourceWaiting',
  'state',
  'status',
  'step',
  'taskDispatch',
  'taskId',
  'tasksFailed',
  'tasksRequeued',
  'to',
  'transport',
  'unit',
  'version',
]);

/** Allowlisted names that still must never carry a value. */
const REDACTED_KEY =
  /(token|secret|password|passwd|apikey|api_key|credential|content|payload|prompt|transcript|memory|body)/iu;

/** Internal event names. A caller-supplied string that misses this is dropped. */
const EVENT_NAME = /^[a-z][a-z0-9._-]{0,80}$/u;

/**
 * Adapter-side stimulus reference. Same shape as the contracts pattern: opaque,
 * and too narrow to carry prose. The raw value is still not logged.
 */
const ADAPTER_EVENT_REF = /^[A-Za-z0-9._:-]{1,64}$/u;

/**
 * Reasons the daemon and the runtime emit. A free-text stop reason or an
 * external string is not in this set. Step notes are the fixed strings from
 * the lifecycle table, not caller input.
 */
const ALLOWED_REASONS: ReadonlySet<string> = new Set([
  'SIGINT',
  'SIGTERM',
  'aborted',
  'archive_conflict',
  'archive_state_present',
  'archive_unavailable',
  'auth_failed',
  'buffer_lost',
  'concurrent_modification',
  'explicit env config, no fallbacks',
  'in-process ingress only; no transport and no external input',
  'invalid_task_row',
  'loopback API/WebSocket not implemented',
  'no health transport; status is available in-process only',
  'no transport receives events yet',
  'no work is dispatched',
  'normalize crashed personas; nothing is auto-started',
  'not_implemented',
  'persona_budget_exceeded',
  'probe_budget_exceeded',
  'processing_failed',
  'queue_overflow',
  'rate_limited',
  'recoverRuntime is fail-closed; no scheduler in this phase',
  'requested',
  'row_budget_exceeded',
  'running with an empty handler map; tasks are not dispatched',
  'runtime_not_implemented',
  'scan_query_budget_exceeded',
  'schema_invalid',
  'startup_failed',
  'stop_requested',
  'ttl_expired',
  'unexpected_event_status',
  'untrusted_source',
  'atomic, data-dir scoped, owner-checked release',
  'directory + real write probe, no temp fallback',
  'expected P1 shape, column order included',
  'packaged migrations, checksum verified',
  'single writer, WAL',
  'structured JSON lines, content redacted',
]);

const REDACTED = '[redacted]';
const INVALID_EVENT = 'invalid_event';
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

function eventName(event: string): string {
  return EVENT_NAME.test(event) ? event : INVALID_EVENT;
}

function adapterEventRef(value: unknown): string {
  if (typeof value !== 'string' || !ADAPTER_EVENT_REF.test(value)) {
    return REDACTED;
  }
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `ref_${digest}`;
}

function reasonValue(value: unknown): string {
  return typeof value === 'string' && ALLOWED_REASONS.has(value) ? value : REDACTED;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === 'string' ? { code } : {}),
      // `message` is untrusted free text (credentials, user content, model
      // output); keep the field shape but never the original text.
      message: REDACTED,
    };
  }
  if (depth >= MAX_DEPTH) {
    return '[depth-limit]';
  }
  if (Array.isArray(value)) {
    const visible = value.slice(0, MAX_ARRAY).map((entry) => sanitizeValue(entry, depth + 1));
    return value.length > MAX_ARRAY ? [...visible, `[+${value.length - MAX_ARRAY} more]`] : visible;
  }
  if (typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  }
  return String(value);
}

function sanitizeRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'source' || key === 'adapterId') {
      // No adapter registry is implemented. A pattern match is not registration.
      result[key] = REDACTED;
      continue;
    }
    if (key === 'adapterEventRef') {
      result[key] = adapterEventRef(value);
      continue;
    }
    if (key === 'reason') {
      result[key] = reasonValue(value);
      continue;
    }
    if (!ALLOWED_LOG_KEYS.has(key) || REDACTED_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = sanitizeValue(value, depth);
  }
  return result;
}

/** Builds a logger writing one JSON line per record. */
export function createLogger(options: LoggerOptions): Logger {
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? ((): Date => new Date());

  const emit = (level: LogLevel, bindings: LogFields, event: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.level]) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      event: eventName(event),
      ...sanitizeRecord(bindings, 0),
      ...sanitizeRecord(fields ?? {}, 0),
    };
    sink(JSON.stringify(record));
  };

  const make = (bindings: LogFields): Logger => ({
    level: options.level,
    debug: (event, fields) => emit('debug', bindings, event, fields),
    info: (event, fields) => emit('info', bindings, event, fields),
    warn: (event, fields) => emit('warn', bindings, event, fields),
    error: (event, fields) => emit('error', bindings, event, fields),
    child: (extra) => make({ ...bindings, ...extra }),
  });

  return make({ pid: process.pid });
}
