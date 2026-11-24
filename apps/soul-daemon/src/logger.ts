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
 * redacted too. `Error` objects are reduced to `{ name, code, message:
 * '[redacted]' }`. `Error.message` is untrusted free text, and a plain string
 * field named `message` is not allowlisted, so neither path writes it.
 */

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

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;

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
      event,
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
