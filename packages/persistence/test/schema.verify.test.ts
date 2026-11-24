import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { databaseOf } from '../src/db/store.js';
import { PersistenceError } from '../src/errors.js';
import { migrate, openStore, verifySchema } from '../src/index.js';
import type { Store } from '../src/index.js';
import { dbPathIn, makeTempDir, removeTempDir } from './helpers/temp.js';

const NOW = 1_731_700_000_000;
const PERSONA_ID = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';
const EVENT_ID = 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFH';
const SESSION_ID = 'ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDE';

const dirs: string[] = [];
const stores: Store[] = [];

let dir: string;
let store: Store;
let db: DatabaseSync;

beforeEach(() => {
  dir = makeTempDir();
  dirs.push(dir);
  store = openStore({ file: dbPathIn(dir) });
  stores.push(store);
  migrate(store);
  db = databaseOf(store);
});

afterEach(() => {
  while (stores.length > 0) {
    (stores.pop() as Store).close();
  }
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function insertPersona(id: string = PERSONA_ID): void {
  db.prepare(
    'INSERT INTO personas (id, display_name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Primary', 'RUNNING', NOW, NOW);
}

interface EventOptions {
  readonly id?: string;
  readonly personaId?: string;
  readonly sessionId?: string | null;
  readonly source?: string;
  readonly adapterId?: string;
  readonly ref?: string;
  readonly status?: string;
  readonly reason?: string | null;
}

function insertEvent(options: EventOptions = {}): void {
  db.prepare(
    `INSERT INTO events
       (id, persona_id, session_id, source, adapter_id, adapter_event_ref, status, status_reason, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.id ?? EVENT_ID,
    options.personaId ?? PERSONA_ID,
    options.sessionId ?? null,
    options.source ?? 'minecraft.chat',
    options.adapterId ?? 'minecraft',
    options.ref ?? 'mc-1',
    options.status ?? 'accepted',
    options.reason ?? null,
    NOW,
    NOW,
  );
}

describe('verifySchema', () => {
  it('accepts the freshly migrated database', () => {
    expect(() => verifySchema(store)).not.toThrow();
  });

  it('reports a missing index', () => {
    db.exec('DROP INDEX ux_events_dedupe');

    try {
      verifySchema(store);
      expect.unreachable('a missing index must be reported');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      const persistenceError = error as PersistenceError;
      expect(persistenceError.code).toBe('schema_mismatch');
      expect(persistenceError.details?.['problems']).toContain('missing index: ux_events_dedupe');
    }
  });

  it('reports an unexpected column', () => {
    db.exec('ALTER TABLE personas ADD COLUMN smuggled TEXT');

    try {
      verifySchema(store);
      expect.unreachable('an extra column must be reported');
    } catch (error) {
      expect((error as PersistenceError).code).toBe('schema_mismatch');
      expect((error as PersistenceError).details?.['problems']).toContain(
        'column mismatch: personas',
      );
    }
  });

  it('reports a missing table', () => {
    db.exec('DROP TABLE tasks');

    try {
      verifySchema(store);
      expect.unreachable('a missing table must be reported');
    } catch (error) {
      expect((error as PersistenceError).details?.['problems']).toContain('missing table: tasks');
    }
  });

  it('reports an index that kept its name but lost UNIQUE', () => {
    db.exec('DROP INDEX ux_events_dedupe');
    db.exec(
      'CREATE INDEX ux_events_dedupe ON events (persona_id, adapter_id, source, adapter_event_ref)',
    );

    try {
      verifySchema(store);
      expect.unreachable('a non-unique dedupe index must be reported');
    } catch (error) {
      const problems = (error as PersistenceError).details?.['problems'];
      expect(problems).toContain('schema fingerprint mismatch: ux_events_dedupe');
      expect(problems).not.toContain('missing index: ux_events_dedupe');
    }
  });

  it('reports a partial index that kept its name but lost the predicate', () => {
    db.exec('DROP INDEX ux_sessions_external');
    db.exec(
      'CREATE UNIQUE INDEX ux_sessions_external ON sessions (persona_id, adapter_id, external_id)',
    );

    try {
      verifySchema(store);
      expect.unreachable('a partial index without its predicate must be reported');
    } catch (error) {
      expect((error as PersistenceError).details?.['problems']).toContain(
        'schema fingerprint mismatch: ux_sessions_external',
      );
    }
  });

  it('reports a CHECK constraint removed while the column names stay', () => {
    db.exec(`
      CREATE TABLE tasks_unchecked (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id),
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        state TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        run_id TEXT,
        payload_json TEXT,
        scheduled_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO tasks_unchecked SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_unchecked RENAME TO tasks;
      CREATE INDEX ix_tasks_persona_state ON tasks (persona_id, state, scheduled_at);
    `);

    try {
      verifySchema(store);
      expect.unreachable('a table without its CHECK constraints must be reported');
    } catch (error) {
      const problems = (error as PersistenceError).details?.['problems'];
      expect(problems).toContain('schema fingerprint mismatch: tasks');
      expect(problems).not.toContain('column mismatch: tasks');
      expect(problems).not.toContain('missing index: ix_tasks_persona_state');
    }
  });
});

describe('database constraints', () => {
  it('requires a reason code exactly for the terminal statuses', () => {
    insertPersona();

    expect(() => insertEvent({ status: 'expired' })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent({ status: 'accepted', reason: 'ttl_expired' })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertEvent({ status: 'expired', reason: 'ttl_expired' })).not.toThrow();
  });

  it('rejects a reason code outside the controlled enum', () => {
    insertPersona();
    expect(() => insertEvent({ status: 'rejected', reason: 'not_a_real_reason' })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertEvent({ status: 'rejected', reason: 'schema_invalid' })).not.toThrow();
  });

  it('enforces the dedupe key (persona + adapter + source + ref)', () => {
    insertPersona();
    insertEvent({ id: EVENT_ID, ref: 'mc-1' });

    // Same tuple, different event id.
    expect(() => insertEvent({ id: 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFJ', ref: 'mc-1' })).toThrow(
      /UNIQUE constraint failed/,
    );

    // Different adapter or persona is a different event.
    expect(() =>
      insertEvent({ id: 'evt_01JQ8Z7D9R1T3V5X7Z9A1B3DFK', adapterId: 'qq', ref: 'mc-1' }),
    ).not.toThrow();
  });

  it('enforces one active session per (persona, adapter, external ref)', () => {
    insertPersona();
    db.prepare(
      'INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at) VALUES (?, ?, ?, ?, ?)',
    ).run(SESSION_ID, PERSONA_ID, 'qq', 'qq:group-1', NOW);

    // A second ACTIVE session with the same mapping is refused.
    expect(() =>
      db
        .prepare(
          'INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDF', PERSONA_ID, 'qq', 'qq:group-1', NOW),
    ).toThrow(/UNIQUE constraint failed/);

    // Once the old one is closed, a new window is allowed (re-open = new id).
    db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ?').run(NOW, SESSION_ID);
    expect(() =>
      db
        .prepare(
          'INSERT INTO sessions (id, persona_id, adapter_id, external_id, opened_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run('ses_01JQ8Z4A6N8Q0S3V5W7Y9B1CDF', PERSONA_ID, 'qq', 'qq:group-1', NOW),
    ).not.toThrow();
  });

  it('enforces foreign keys', () => {
    expect(() => insertEvent({ personaId: 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ZZZ' })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('bounds adapter_event_ref to 1..64 characters', () => {
    insertPersona();
    expect(() => insertEvent({ ref: '' })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent({ ref: 'a'.repeat(65) })).toThrow(/CHECK constraint failed/);
    expect(() => insertEvent({ ref: 'a'.repeat(64) })).not.toThrow();
  });

  it('applies the P1 archive defaults: state none, ref and disposition NULL', () => {
    insertPersona();
    insertEvent();

    const row = db
      .prepare(
        'SELECT archive_ref, archive_disposition, archive_state, salience, attention_outcome FROM events',
      )
      .get() as {
      archive_ref: unknown;
      archive_disposition: unknown;
      archive_state: string;
      salience: number;
      attention_outcome: unknown;
    };

    expect(row.archive_ref).toBeNull();
    expect(row.archive_disposition).toBeNull();
    expect(row.archive_state).toBe('none');
    expect(row.salience).toBe(0);
    expect(row.attention_outcome).toBeNull();
  });

  it('stores timestamps as integer milliseconds', () => {
    insertPersona();
    insertEvent();

    const row = db
      .prepare('SELECT typeof(received_at) AS kind, received_at AS value FROM events')
      .get() as { kind: string; value: number };

    expect(row.kind).toBe('integer');
    expect(row.value).toBe(NOW);
  });

  it('rejects an unknown persona state', () => {
    insertPersona();
    expect(() =>
      db.prepare('UPDATE personas SET state = ? WHERE id = ?').run('DREAMING', PERSONA_ID),
    ).toThrow(/CHECK constraint failed/);
  });
});
