/**
 * Expected P1 schema.
 *
 * One list of truth used by two consumers:
 *   - `verifySchema()` — proves an opened database really is at the expected shape
 *   - the field-mapping tests (batch B) — every column round-trips snake↔camel
 *
 * Derived from DATA-MODEL.md §3. When a migration adds or renames a column,
 * changes a constraint, or changes an index, the identifier in this file must
 * be updated in the same change, otherwise `verifySchema()` fails — which is
 * the intended alarm.
 *
 * `P1_SCHEMA_SQL` is the normalized `sqlite_master.sql` of a freshly migrated
 * database: line comments removed, whitespace collapsed. Comparing that text
 * catches a CHECK, foreign key, column type, UNIQUE flag, or partial-index
 * predicate that a name-only check would miss.
 */

export const P1_TABLE_COLUMNS = {
  personas: [
    'id',
    'display_name',
    'state',
    'version',
    'epoch',
    'boot_id',
    'created_at',
    'updated_at',
  ],
  sessions: [
    'id',
    'persona_id',
    'adapter_id',
    'external_id',
    'opened_at',
    'closed_at',
    'meta_json',
  ],
  events: [
    'id',
    'persona_id',
    'session_id',
    'source',
    'adapter_id',
    'adapter_event_ref',
    'status',
    'attention_outcome',
    'salience',
    'summary',
    'archive_ref',
    'received_at',
    'occurred_at',
    'updated_at',
    'archive_disposition',
    'archive_state',
    'status_reason',
  ],
  tasks: [
    'id',
    'persona_id',
    'kind',
    'channel',
    'state',
    'priority',
    'run_id',
    'payload_json',
    'scheduled_at',
    'started_at',
    'finished_at',
    'attempt',
  ],
  runtime_state: ['persona_id', 'state', 'boot_id', 'epoch', 'checkpoint_json', 'updated_at'],
  schema_migrations: ['version', 'name', 'checksum', 'applied_at'],
} as const satisfies Record<string, readonly string[]>;

export type P1TableName = keyof typeof P1_TABLE_COLUMNS;

export const P1_INDEXES = [
  'ix_sessions_persona',
  'ux_sessions_external',
  'ix_events_persona_status',
  'ix_events_session',
  'ux_events_dedupe',
  'ix_tasks_persona_state',
] as const;

/**
 * Normalized SQL for every table and index `verifySchema()` must recognize.
 * Comments are already stripped and whitespace is collapsed; do not reformat
 * these strings by hand without re-reading `sqlite_master` after `migrate()`.
 */
export const P1_SCHEMA_SQL = {
  events:
    "CREATE TABLE events ( id TEXT PRIMARY KEY, persona_id TEXT NOT NULL REFERENCES personas(id), session_id TEXT REFERENCES sessions(id), source TEXT NOT NULL, adapter_id TEXT NOT NULL, adapter_event_ref TEXT NOT NULL CHECK (length(adapter_event_ref) BETWEEN 1 AND 64), status TEXT NOT NULL CHECK (status IN ('received','accepted','noticed','understood', 'response_committed','acted','rejected','expired')), attention_outcome TEXT CHECK (attention_outcome IN ('not_evaluated','ignored','queued','partially_aware','fully_aware','forced_control')), salience REAL NOT NULL DEFAULT 0, summary TEXT, archive_ref TEXT, received_at INTEGER NOT NULL, occurred_at INTEGER, updated_at INTEGER NOT NULL, archive_disposition TEXT CHECK (archive_disposition IN ('required','excluded')), archive_state TEXT NOT NULL DEFAULT 'none' CHECK (archive_state IN ('none','pending','archived','failed','excluded')), status_reason TEXT, CHECK ( (status IN ('expired','rejected') AND status_reason IS NOT NULL) OR (status NOT IN ('expired','rejected') AND status_reason IS NULL) ), CHECK ( status_reason IS NULL OR (status = 'expired' AND status_reason IN ('buffer_lost','ttl_expired','queue_overflow')) OR (status = 'rejected' AND status_reason IN ('auth_failed','untrusted_source','schema_invalid','rate_limited', 'archive_unavailable','archive_conflict','processing_failed')) ) )",
  ix_events_persona_status:
    'CREATE INDEX ix_events_persona_status ON events (persona_id, status, received_at)',
  ix_events_session: 'CREATE INDEX ix_events_session ON events (session_id, received_at)',
  ix_sessions_persona: 'CREATE INDEX ix_sessions_persona ON sessions (persona_id, opened_at DESC)',
  ix_tasks_persona_state:
    'CREATE INDEX ix_tasks_persona_state ON tasks (persona_id, state, scheduled_at)',
  personas:
    "CREATE TABLE personas ( id TEXT PRIMARY KEY, display_name TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('CREATED','STARTING','RUNNING','SUSPENDED','STOPPING','STOPPED','FAILED')), version INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, boot_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )",
  runtime_state:
    'CREATE TABLE runtime_state ( persona_id TEXT PRIMARY KEY REFERENCES personas(id), state TEXT NOT NULL, boot_id TEXT, epoch INTEGER NOT NULL, checkpoint_json TEXT, updated_at INTEGER NOT NULL )',
  schema_migrations:
    'CREATE TABLE schema_migrations ( version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL )',
  sessions:
    'CREATE TABLE sessions ( id TEXT PRIMARY KEY, persona_id TEXT NOT NULL REFERENCES personas(id), adapter_id TEXT NOT NULL, external_id TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER, meta_json TEXT )',
  tasks:
    "CREATE TABLE tasks ( id TEXT PRIMARY KEY, persona_id TEXT NOT NULL REFERENCES personas(id), kind TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('external','inner','sleep','dream','audit')), state TEXT NOT NULL CHECK (state IN ('queued','running','paused','done','failed','cancelled')), priority INTEGER NOT NULL DEFAULT 0, run_id TEXT, payload_json TEXT, scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER, attempt INTEGER NOT NULL DEFAULT 0 )",
  ux_events_dedupe:
    'CREATE UNIQUE INDEX ux_events_dedupe ON events (persona_id, adapter_id, source, adapter_event_ref)',
  ux_sessions_external:
    'CREATE UNIQUE INDEX ux_sessions_external ON sessions (persona_id, adapter_id, external_id) WHERE external_id IS NOT NULL AND closed_at IS NULL',
} as const satisfies Record<string, string>;
