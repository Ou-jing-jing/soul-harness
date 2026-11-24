/**
 * Cross-package consumer check — runtime half.
 *
 * Imports the packages by name (resolved through the workspace link) and asserts
 * that the built ESM entry actually exposes the intended surface. Runs after
 * `pnpm run build`, so it validates `dist/`, not the sources.
 *
 * For persistence this goes further than symbol sniffing: it opens a real
 * database file, runs the shipped migrations (proving `defaultMigrationsDir`
 * resolves correctly from `dist/`), writes through a repository, saves and reads
 * a checkpoint, and closes. That is the "future Runtime consumes this package"
 * claim, executed.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

import {
  ERROR_MESSAGES,
  SCHEMA_IDS,
  STIMULUS_INPUT_VERSION,
  isCoreId,
  isPersonaId,
  isTaskId,
  stimulusInputV1Schema,
} from '@soul-harness/contracts';
import * as persistence from '@soul-harness/persistence';
import * as runtime from '@soul-harness/runtime';

assert.equal(SCHEMA_IDS.length, 10, 'expected 10 registered schemas');
assert.equal(STIMULUS_INPUT_VERSION, 'soul.stimulus.input.v1');
assert.equal(stimulusInputV1Schema.$id, 'soul.stimulus.input.v1');
assert.equal(isPersonaId('psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC'), true);
assert.equal(isCoreId('tsk_01JQ8Z6B7P9R1T3V5X7Z9A2BDF'), false);
assert.equal(ERROR_MESSAGES.schema_invalid, 'envelope failed schema validation');

// --- the published surface must not leak internals ---------------------------

for (const internal of [
  'databaseOf',
  'readDatabaseOf',
  'setReadGuardFaultForTests',
  'takeReadGuardFault',
  'createGuardedStatement',
]) {
  assert.equal(internal in persistence, false, `${internal} must not be exported`);
}

const { createRepositories, isPersistenceError, migrate, openStore, withRead, withWrite } =
  persistence;

const PERSONA = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC';
const NOW = 1_731_700_000_000;
const dir = mkdtempSync(join(tmpdir(), 'sh-consumer-'));

try {
  const store = openStore({ file: join(dir, 'soul.db') });

  const result = migrate(store);
  assert.deepEqual(result.applied, [1], 'the shipped migrations must apply');
  assert.equal(result.currentVersion, 1);

  const repos = createRepositories(store);
  repos.personas.insert({
    id: PERSONA,
    displayName: 'Consumer',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  repos.runtimeState.upsert({ personaId: PERSONA, state: 'RUNNING', epoch: 1, updatedAt: NOW });
  repos.checkpoints.save({
    personaId: PERSONA,
    epoch: 1,
    refs: { cursor: 'consumer:0' },
    updatedAt: NOW + 1,
  });

  const loaded = repos.checkpoints.load(PERSONA);
  assert.equal(loaded.status, 'present');
  assert.equal(loaded.stored.checkpoint.refs.cursor, 'consumer:0');
  assert.equal(repos.personas.getById(PERSONA).displayName, 'Consumer');

  // Transaction surface: no arbitrary SQL entry point, read scopes are read-only.
  withWrite(store, (tx) => {
    assert.equal('exec' in tx, false, 'Tx must not expose exec');
  });

  const readCount = withRead(
    store,
    (tx) => tx.prepare('SELECT count(*) AS n FROM personas').get().n,
  );
  assert.equal(readCount, 1);

  let rejected = false;
  try {
    withRead(store, (tx) => tx.prepare('INSERT INTO personas (id) VALUES (?)').run('psn_x'));
  } catch (error) {
    rejected = isPersistenceError(error) && error.code === 'statement_blocked';
  }
  assert.equal(rejected, true, 'read scope must refuse writes');

  store.close();
  assert.throws(
    () => repos.personas.getById(PERSONA),
    (error) => isPersistenceError(error) && error.code === 'store_closed',
  );
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// --- runtime: allocator, persona lifecycle, and in-process ingress ----------

for (const absent of ['createRuntime', 'enqueueTask', 'recover', 'checkpointAll']) {
  assert.equal(absent in runtime, false, `${absent} must not be exported yet`);
}

assert.equal('acceptStimulus' in runtime, false, 'acceptStimulus is a method, not a free function');
assert.equal(typeof runtime.createStimulusIngress, 'function');
assert.equal(runtime.DEDUPE_BODY_UNVERIFIABLE_METRIC, 'dedupe.body_unverifiable');

assert.equal(typeof runtime.createPersonaLifecycle, 'function');
assert.equal(runtime.PERSONA_DISPLAY_NAME_MAX_LENGTH, 128);

const allocated = runtime.allocatePersonaId();
assert.equal(typeof allocated, 'string');
assert.equal(allocated.length, 30);
assert.equal(isPersonaId(allocated), true);
assert.equal(isCoreId(runtime.allocateTaskId()), false);
assert.equal(isTaskId(runtime.allocateTaskId()), true);
assert.equal(runtime.ID_ALLOCATION_MAX_ATTEMPTS, 8);
assert.equal(runtime.ID_ENTROPY_BYTES, 10);

const fixed = runtime.allocateEventId({
  now: () => 0,
  randomBytes: () => new Uint8Array(10),
});
assert.equal(fixed, `evt_${'0'.repeat(26)}`);

let occupied = true;
const retried = runtime.allocateEventId({
  now: () => 0,
  randomBytes: () => {
    const bytes = new Uint8Array(10);
    bytes[0] = occupied ? 1 : 2;
    return bytes;
  },
  isOccupied: () => {
    const taken = occupied;
    occupied = false;
    return taken;
  },
});
assert.notEqual(retried, fixed);
assert.equal(isCoreId(retried), true);

assert.throws(
  () =>
    runtime.allocateRunId({
      now: () => 0,
      randomBytes: () => new Uint8Array(10),
      isOccupied: () => true,
      maxAttempts: 2,
    }),
  (error) => runtime.isRuntimeError(error) && error.code === 'id_collision',
);

const runtimeDir = mkdtempSync(join(tmpdir(), 'sh-consumer-runtime-'));
try {
  const runtimeStore = persistence.openStore({ file: join(runtimeDir, 'soul.db') });
  persistence.migrate(runtimeStore);
  const noop = { debug() {}, info() {}, warn() {}, error() {} };
  const life = runtime.createPersonaLifecycle({
    store: runtimeStore,
    logger: noop,
    bootId: 'consumer-boot',
  });
  const created = await life.createPersona({ displayName: 'Consumer' });
  assert.equal(isPersonaId(created.id), true);
  assert.equal(created.state, 'CREATED');
  assert.equal(created.epoch, 1);
  assert.equal(created.version, 0);
  const started = await life.startPersona(created.id);
  assert.equal(started.state, 'RUNNING');
  assert.equal(started.version, 2);
  assert.equal(started.bootId, 'consumer-boot');
  assert.equal(started.epoch, 1);
  assert.equal(started.runtimeState.epoch, 1);
  const suspended = await life.suspendPersona(created.id);
  assert.equal(suspended.state, 'SUSPENDED');
  const resumed = await life.resumePersona(created.id);
  assert.equal(resumed.state, 'RUNNING');
  const stopped = await life.stopPersona(created.id);
  assert.equal(stopped.state, 'STOPPED');
  assert.equal(stopped.version, 6);
  const restored = life.restorePersona(created.id);
  assert.equal(restored.id, created.id);
  assert.equal(life.listPersonas().length, 1);
  await life.startPersona(created.id);
  await assert.rejects(
    life.startPersona(created.id),
    (error) => runtime.isRuntimeError(error) && error.code === 'illegal_transition',
  );
  const bus = runtime.createStimulusIngress({
    store: runtimeStore,
    logger: noop,
    now: () => 8_000,
    config: { queueCapacity: 2, bufferTtlMs: 1_000, personaAdmissionCapacity: 8 },
  });
  const canary = 'consumer-canary-body';
  const accepted = await bus.acceptStimulus({
    stimulus: {
      schema: STIMULUS_INPUT_VERSION,
      personaId: created.id,
      adapterId: 'minecraft',
      source: 'minecraft.chat',
      adapterEventRef: 'mc-consumer',
      requestNonce: 'NQ7xK2mR9tVb4Wc8',
      payload: { kind: 'mc.world', version: 1, text: canary },
    },
  });
  assert.equal(accepted.outcome, 'accepted');
  assert.equal(accepted.audited, false);
  assert.equal(accepted.receivedAt, 8_000);
  assert.equal(accepted.archiveState, 'none');
  const again = await bus.acceptStimulus({
    stimulus: {
      schema: STIMULUS_INPUT_VERSION,
      personaId: created.id,
      adapterId: 'minecraft',
      source: 'minecraft.chat',
      adapterEventRef: 'mc-consumer',
      requestNonce: 'NQ7xK2mR9tVb4Wc8',
      payload: { kind: 'mc.world', version: 1, text: 'different-body' },
    },
  });
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.eventId, accepted.eventId);
  assert.equal(again.bodyVerified, false);
  assert.equal(bus.metrics()[runtime.DEDUPE_BODY_UNVERIFIABLE_METRIC], 1);
  const buffered = bus.readBuffered(created.id, accepted.eventId);
  assert.equal(buffered.payload.text, canary);
  const stored = persistence
    .createRepositories(runtimeStore)
    .events.getById({ personaId: created.id, id: accepted.eventId });
  assert.equal(stored.status, 'accepted');
  assert.equal(stored.archiveState, 'none');
  assert.equal(stored.summary, null);
  assert.equal(JSON.stringify(stored).includes(canary), false);
  bus.close();
  runtimeStore.close();
} finally {
  rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// --- runtime: SH-008D D2/D3/D4 — Recovery, Scheduler, and the Store lease ----

for (const internal of ['acquireStoreLease', 'hasStoreLease']) {
  assert.equal(internal in runtime, false, `${internal} must not be exported`);
}
assert.equal(typeof runtime.recoverRuntime, 'function');
assert.equal(typeof runtime.createScheduler, 'function');

const POLICY = { maxAttempts: 3, retryBackoffMs: 0 };
const noop = { debug() {}, info() {}, warn() {}, error() {} };
const noopTimers = { setTimeout: () => 0, clearTimeout: () => {} };
const TASK_ID = `tsk_${'0'.repeat(24)}01`;
const EVENT_ID = `evt_${'0'.repeat(24)}02`;

const openConsumerStore = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), `sh-consumer-${prefix}-`));
  const store = persistence.openStore({ file: join(dir, 'soul.db') });
  persistence.migrate(store);
  return { dir, store, repos: persistence.createRepositories(store) };
};
const closeConsumerStore = ({ dir, store }) => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
};

// 3.1 Recovery against a real migrated database, through the built package.
{
  const fixture = openConsumerStore('recovery');
  try {
    const report = await runtime.recoverRuntime({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      now: () => NOW,
    });
    assert.equal(report.incomplete, null, 'empty database recovery must be complete');
    assert.deepEqual(report.tasks, { requeued: 0, failed: 0 });
    assert.deepEqual(report.events, { expired: 0 });
    assert.equal(report.personasScanned, 0);
  } finally {
    closeConsumerStore(fixture);
  }
}

// 3.2 Scheduler lifecycle, through the built package.
{
  const fixture = openConsumerStore('scheduler');
  try {
    fixture.repos.personas.insert({
      id: PERSONA,
      displayName: 'Scheduler consumer',
      state: 'RUNNING',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const scheduler = runtime.createScheduler({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      handlers: { 'thought.run': () => undefined },
      now: () => NOW,
      timers: noopTimers,
    });
    assert.equal(scheduler.state, 'created');
    scheduler.start();
    assert.equal(scheduler.state, 'running');
    await scheduler.stop();
    assert.equal(scheduler.state, 'stopped');
    assert.deepEqual(scheduler.stats(), { state: 'stopped', activeHandlers: 0, activeUnits: 0 });
    assert.throws(
      () => scheduler.start(),
      (error) => runtime.isRuntimeError(error) && error.code === 'illegal_transition',
    );
    await scheduler.stop(); // repeated stop is idempotent
  } finally {
    closeConsumerStore(fixture);
  }
}

// 3.3-A Scheduler lease blocks Recovery, and Recovery runs after stop.
{
  const fixture = openConsumerStore('lease-a');
  try {
    fixture.repos.personas.insert({
      id: PERSONA,
      displayName: 'Lease A',
      state: 'RUNNING',
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture.repos.tasks.insertQueuedTask({
      id: TASK_ID,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
    });
    fixture.repos.events.commitP1Envelope({
      id: EVENT_ID,
      personaId: PERSONA,
      source: 'minecraft.chat',
      adapterId: 'minecraft',
      adapterEventRef: 'lease-a-1',
      receivedAt: NOW,
      updatedAt: NOW,
      outcome: { status: 'accepted' },
    });
    const scheduler = runtime.createScheduler({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      handlers: { 'thought.run': () => undefined },
      now: () => NOW,
      timers: noopTimers,
    });
    const tasksBefore = fixture.repos.tasks.listByPersonaState({
      personaId: PERSONA,
      state: 'queued',
    });
    const eventBefore = fixture.repos.events.getById({ personaId: PERSONA, id: EVENT_ID });
    await assert.rejects(
      runtime.recoverRuntime({
        store: fixture.store,
        logger: noop,
        policy: POLICY,
        now: () => NOW,
      }),
      (error) => runtime.isRuntimeError(error) && error.code === 'illegal_transition',
    );
    assert.deepEqual(
      fixture.repos.tasks.listByPersonaState({ personaId: PERSONA, state: 'queued' }),
      tasksBefore,
      'a rejected Recovery must not change task rows',
    );
    assert.deepEqual(
      fixture.repos.events.getById({ personaId: PERSONA, id: EVENT_ID }),
      eventBefore,
      'a rejected Recovery must not change event rows',
    );
    await scheduler.stop();
    const report = await runtime.recoverRuntime({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      now: () => NOW,
    });
    assert.equal(report.incomplete, null, 'Recovery must run after Scheduler stop');
  } finally {
    closeConsumerStore(fixture);
  }
}

// 3.3-B Recovery lease blocks Scheduler creation inside the scan body.
//
// The `recovery_started` logger callback is invoked by `runRecovery` after the
// wrapper acquired the lease and before the scan queries run. Attempting to
// create the Scheduler from that callback is therefore a deterministic in-body
// probe: no sleep, no race, and no test-only production API.
{
  const fixture = openConsumerStore('lease-b');
  let reentrantScheduler = null;
  try {
    let startedCalls = 0;
    let reentrantError = null;
    const reentrantLogger = {
      debug() {},
      info(event) {
        if (event !== 'recovery_started') {
          return;
        }
        startedCalls += 1;
        try {
          reentrantScheduler = runtime.createScheduler({
            store: fixture.store,
            logger: noop,
            policy: POLICY,
            handlers: { 'thought.run': () => undefined },
            now: () => NOW,
            timers: noopTimers,
          });
        } catch (error) {
          // The probe must never escape the logger callback.
          reentrantError = error;
        }
      },
      warn() {},
      error() {},
    };

    const report = await runtime.recoverRuntime({
      store: fixture.store,
      logger: reentrantLogger,
      policy: POLICY,
      now: () => NOW,
    });

    assert.equal(startedCalls, 1, 'recovery_started must fire exactly once');
    assert.notEqual(reentrantError, null, 'Scheduler creation inside Recovery must fail');
    assert.equal(runtime.isRuntimeError(reentrantError), true);
    assert.equal(reentrantError.code, 'illegal_transition');
    assert.equal(report.incomplete, null);

    const scheduler = runtime.createScheduler({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      handlers: { 'thought.run': () => undefined },
      now: () => NOW,
      timers: noopTimers,
    });
    assert.equal(scheduler.state, 'created');
    await scheduler.stop();
    assert.equal(scheduler.state, 'stopped');
  } finally {
    if (reentrantScheduler !== null) {
      await reentrantScheduler.stop();
    }
    closeConsumerStore(fixture);
  }
}

// 3.4 The lease is held until stop finishes, not released when stop begins.
{
  const fixture = openConsumerStore('lease-stop');
  try {
    fixture.repos.personas.insert({
      id: PERSONA,
      displayName: 'Lease stop',
      state: 'RUNNING',
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture.repos.tasks.insertQueuedTask({
      id: TASK_ID,
      personaId: PERSONA,
      kind: 'thought.run',
      channel: 'inner',
    });
    let releaseHandler;
    const gate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const scheduler = runtime.createScheduler({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      handlers: { 'thought.run': () => gate },
      now: () => NOW,
      timers: noopTimers,
    });
    scheduler.start();
    await scheduler.tick();
    assert.equal(scheduler.stats().activeHandlers, 1);

    const stopping = scheduler.stop();
    assert.equal(scheduler.state, 'stopping');
    await assert.rejects(
      runtime.recoverRuntime({
        store: fixture.store,
        logger: noop,
        policy: POLICY,
        now: () => NOW,
      }),
      (error) => runtime.isRuntimeError(error) && error.code === 'illegal_transition',
    );

    releaseHandler();
    await stopping;
    assert.equal(scheduler.state, 'stopped');
    assert.equal(scheduler.stats().activeHandlers, 0);
    const report = await runtime.recoverRuntime({
      store: fixture.store,
      logger: noop,
      policy: POLICY,
      now: () => NOW,
    });
    assert.equal(report.incomplete, null, 'lease must be released only after stop completes');
  } finally {
    closeConsumerStore(fixture);
  }
}

// 3.5 A claimed task that dies RUNNING is requeued, claimed again under a new
// run id, and only that new run can complete it.
//
// The first claim runs in a child process that exits without settling, which
// is the crash. `completeTask(run A)` is attempted while the second claim is
// still RUNNING, so a null result means the stale run was rejected rather than
// "the task was already done".
{
  const dir = mkdtempSync(join(tmpdir(), 'sh-consumer-redispatch-'));
  const file = join(dir, 'soul.db');
  const taskId = `tsk_${'0'.repeat(24)}09`;
  const opened = persistence.openStore({ file });
  persistence.migrate(opened);
  const seeded = persistence.createRepositories(opened);
  seeded.personas.insert({
    id: PERSONA,
    displayName: 'Redispatch',
    state: 'RUNNING',
    createdAt: NOW,
    updatedAt: NOW,
  });
  seeded.tasks.insertQueuedTask({
    id: taskId,
    personaId: PERSONA,
    kind: 'thought.run',
    channel: 'inner',
  });
  opened.close();

  const childSource = `import * as persistence from '@soul-harness/persistence';
import * as runtime from '@soul-harness/runtime';

const file = process.argv[1];
const personaId = process.argv[2];
const taskId = process.argv[3];
const store = persistence.openStore({ file });
const repos = persistence.createRepositories(store);
const scheduler = runtime.createScheduler({
  store,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  policy: { maxAttempts: 3, retryBackoffMs: 0 },
  handlers: { 'thought.run': () => new Promise(() => {}) },
  now: () => ${NOW},
  timers: { setTimeout: () => 0, clearTimeout: () => {} },
});
scheduler.start();
await scheduler.tick();
const row = repos.tasks.getById({ personaId, id: taskId });
if (row === null || row.state !== 'running' || row.runId === null) {
  console.error('claim did not leave a running row');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ state: row.state, attempt: row.attempt, runId: row.runId }));
try { store.close(); } catch { /* the process is exiting */ }
process.exit(0);
`;

  const claimed = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', childSource, file, PERSONA, taskId],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`crash claim exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });

  assert.equal(claimed.state, 'running');
  assert.equal(claimed.attempt, 1);
  assert.equal(typeof claimed.runId, 'string');
  const runA = claimed.runId;

  const store = persistence.openStore({ file });
  try {
    const repos = persistence.createRepositories(store);
    const report = await runtime.recoverRuntime({
      store,
      logger: noop,
      policy: POLICY,
      now: () => NOW,
    });
    assert.equal(report.incomplete, null, 'recovery after a crash must complete');
    assert.equal(report.tasks.requeued, 1);
    const requeued = repos.tasks.getById({ personaId: PERSONA, id: taskId });
    assert.equal(requeued.state, 'queued');
    assert.equal(requeued.attempt, 1);
    assert.equal(requeued.runId, runA);

    let releaseHandler;
    const gate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const scheduler = runtime.createScheduler({
      store,
      logger: noop,
      policy: POLICY,
      handlers: { 'thought.run': () => gate },
      now: () => NOW,
      timers: noopTimers,
    });
    scheduler.start();
    await scheduler.tick();
    const second = repos.tasks.getById({ personaId: PERSONA, id: taskId });
    assert.equal(second.state, 'running');
    assert.equal(second.attempt, 2);
    assert.notEqual(second.runId, runA);
    const runB = second.runId;

    const stale = repos.tasks.completeTask({
      id: taskId,
      personaId: PERSONA,
      runId: runA,
      expectedAttempt: 1,
      finishedAt: NOW,
    });
    assert.equal(stale, null, 'the crashed run must not be able to complete the task');
    assert.equal(repos.tasks.getById({ personaId: PERSONA, id: taskId }).state, 'running');

    const live = repos.tasks.completeTask({
      id: taskId,
      personaId: PERSONA,
      runId: runB,
      expectedAttempt: 2,
      finishedAt: NOW,
    });
    assert.notEqual(live, null, 'the run that holds the task must be able to complete it');
    assert.equal(live.state, 'done');
    assert.equal(live.runId, runB);
    assert.equal(live.attempt, 2);

    releaseHandler();
    await scheduler.stop();
    const done = repos.tasks.getById({ personaId: PERSONA, id: taskId });
    assert.equal(done.state, 'done');
    assert.equal(done.runId, runB);
    assert.equal(done.attempt, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

console.log(
  `consumer-check ok: package-name imports resolved, ${SCHEMA_IDS.length} schemas, persistence E2E ok, runtime persona lifecycle and P1 ingress ok, recovery and scheduler E2E ok, Store lease mutual exclusion ok, recovered task redispatch ok`,
);
