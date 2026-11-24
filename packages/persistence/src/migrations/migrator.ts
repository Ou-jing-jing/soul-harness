/**
 * Migration execution and schema verification.
 *
 * Contract (DATA-MODEL §8):
 *   - one file per change, tracked in `schema_migrations` with a checksum
 *   - already applied migrations are verified, never re-executed
 *   - each pending migration runs inside its own transaction; failure leaves
 *     neither partial DDL nor a tracking row
 *   - an applied migration whose checksum no longer matches is an error, not a
 *     silent accept
 *
 * Ordering rules (decision D3): versions must be unique; gaps are allowed
 * (`0001`, `0003`); a pending migration older than an applied one is rejected
 * because applying it would rewrite history.
 */

import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { databaseOf, type Store } from '../db/store.js';
import { allRows, oneRow } from '../db/rows.js';
import { PersistenceError } from '../errors.js';
import { assertStoreUsable } from '../tx/coordinator.js';
import { P1_INDEXES, P1_SCHEMA_SQL, P1_TABLE_COLUMNS } from './expected-schema.js';
import { formatMigrationVersion, loadMigrationsFromDir, normalizeMigrations } from './load.js';
import type { AppliedMigration, MigrateOptions, MigrateResult, MigrationFile } from './types.js';

/**
 * Default migrations directory (`packages/persistence/migrations`).
 *
 * `src/migrations/` and `dist/migrations/` sit at the same depth below the
 * package root, so one relative URL works for both the source (vitest) and the
 * built package.
 */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: number;
}

/**
 * Bootstrap of the tracking table.
 *
 * The migrator must be able to record a migration *before* any migration file
 * has run, and a caller may legitimately supply its own migration set (tests,
 * recovery tooling). Creating the table here — with the exact DDL from
 * DATA-MODEL §3 — keeps every run self-sufficient; `0001_init_core.sql` repeats
 * the same definition with `IF NOT EXISTS` so a fresh database reaches the same
 * shape through either path.
 */
function ensureTrackingTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  INTEGER NOT NULL
  )`);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = oneRow<{ present?: number }>(
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"),
    name,
  );
  return row !== undefined;
}

function readApplied(db: DatabaseSync): readonly AppliedMigration[] {
  const rows = allRows<MigrationRow>(
    db.prepare(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    ),
  );

  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

function applyOne(db: DatabaseSync, migration: MigrationFile): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(migration.version, migration.name, migration.checksum, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may have rolled back already; the original error is what matters.
    }
    throw new PersistenceError(
      'migration_failed',
      `migration ${formatMigrationVersion(migration.version)}_${migration.name} failed and was rolled back`,
      { cause: error, details: { version: migration.version } },
    );
  }
}

/**
 * Verifies applied migrations against the source tree, then applies the pending ones.
 *
 * Refuses a store whose cleanup failed: migrations are a public Persistence
 * operation, and "unusable" means no further database access — not even reading
 * the tracking table. The check runs before any SQL.
 */
export function migrate(store: Store, options: MigrateOptions = {}): MigrateResult {
  assertStoreUsable(store);
  const db = databaseOf(store);
  // Both sources pass the same gate: version range, name shape, uniqueness and
  // ascending order are guaranteed before anything executes.
  const migrations = normalizeMigrations(
    options.migrations ?? loadMigrationsFromDir(options.dir ?? defaultMigrationsDir()),
  );

  ensureTrackingTable(db);
  const applied = tableExists(db, 'schema_migrations') ? readApplied(db) : [];
  const known = new Map<number, MigrationFile>(
    migrations.map((migration) => [migration.version, migration]),
  );

  for (const row of applied) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new PersistenceError(
        'migration_not_found',
        'the database has a migration that is missing from the source tree',
        { details: { version: row.version } },
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new PersistenceError(
        'migration_checksum_mismatch',
        `migration ${formatMigrationVersion(row.version)}_${row.name} changed after it was applied`,
        { details: { version: row.version } },
      );
    }
  }

  const lastApplied =
    applied.length === 0 ? 0 : (applied[applied.length - 1] as AppliedMigration).version;
  const appliedVersions = new Set(applied.map((row) => row.version));

  // A migration that exists in the tree, was never applied, and is older than
  // the highest applied version can never run in the right position: applying
  // it now would rewrite history. Skipping it silently would be worse.
  const stale = migrations.filter(
    (migration) => !appliedVersions.has(migration.version) && migration.version < lastApplied,
  );
  if (stale.length > 0) {
    const first = stale[0] as MigrationFile;
    throw new PersistenceError(
      'migration_out_of_order',
      'a pending migration is older than an already applied one',
      { details: { version: first.version, lastApplied } },
    );
  }

  const pending = migrations.filter((migration) => migration.version > lastApplied);

  const appliedNow: number[] = [];
  for (const migration of pending) {
    applyOne(db, migration);
    appliedNow.push(migration.version);
  }

  return {
    applied: appliedNow,
    alreadyApplied: applied.map((row) => row.version),
    currentVersion:
      appliedNow.length > 0 ? (appliedNow[appliedNow.length - 1] as number) : lastApplied,
  };
}

/**
 * Proves the database really has the expected P1 shape.
 *
 * Column order is compared too: it catches a table recreated with a different
 * column set that still satisfies "the name exists". The normalized
 * `sqlite_master` SQL is compared as well, so a kept index name with the
 * UNIQUE flag or partial predicate removed, or a CHECK / foreign key deleted
 * from a table, is still a mismatch.
 *
 * A store whose cleanup failed is refused before any schema query runs: the
 * connection state is unknown, so a successful verdict would be meaningless.
 */
export function verifySchema(store: Store): void {
  assertStoreUsable(store);
  const db = databaseOf(store);
  const problems: string[] = [];

  for (const [table, expectedColumns] of Object.entries(P1_TABLE_COLUMNS)) {
    const rows = allRows<{ name: string }>(
      db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid'),
      table,
    );

    if (rows.length === 0) {
      problems.push(`missing table: ${table}`);
      continue;
    }

    const actual = rows.map((row) => row.name);
    if (
      actual.length !== expectedColumns.length ||
      actual.some((name, index) => name !== expectedColumns[index])
    ) {
      problems.push(`column mismatch: ${table}`);
    }
  }

  for (const index of P1_INDEXES) {
    const row = oneRow<{ present?: number }>(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?"),
      index,
    );
    if (row === undefined) {
      problems.push(`missing index: ${index}`);
    }
  }

  for (const [name, expectedSql] of Object.entries(P1_SCHEMA_SQL)) {
    const row = oneRow<{ sql?: string | null }>(
      db.prepare('SELECT sql FROM sqlite_master WHERE name = ?'),
      name,
    );
    if (row?.sql == null || row.sql === '') {
      problems.push(`schema fingerprint missing: ${name}`);
      continue;
    }
    if (normalizeSchemaSql(row.sql) !== expectedSql) {
      problems.push(`schema fingerprint mismatch: ${name}`);
    }
  }

  if (problems.length > 0) {
    throw new PersistenceError(
      'schema_mismatch',
      'database schema does not match the expected P1 shape',
      {
        details: { problems: problems.join('; ') },
      },
    );
  }
}

/** Drops line comments and collapses whitespace so formatting is not the fingerprint. */
function normalizeSchemaSql(sql: string): string {
  const withoutComments = sql
    .split('\n')
    .map((line) => {
      const mark = line.indexOf('--');
      return mark === -1 ? line : line.slice(0, mark);
    })
    .join('\n');
  return withoutComments.replace(/\s+/g, ' ').trim();
}
