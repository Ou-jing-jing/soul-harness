/**
 * Lifecycle vocabulary.
 *
 * The phase names and their order come from RUNTIME-LIFECYCLE §2/§3 and are not
 * negotiable. Steps say what this process actually does. Recovery, the
 * in-process ingress, and the empty-handler scheduler are implemented. HTTP
 * and health stay `not_implemented`. Static `CAPABILITIES` is not rewritten
 * when a step starts running.
 *
 * That is the difference between "the database is open" and "the runtime has
 * recovered". Persona normalize and `recoverRuntime` run in RECOVERING. READY
 * creates an in-process ingress with no transport and a scheduler with an
 * empty handler map. HTTP and health stay unimplemented.
 */

export const BOOT_PHASES = ['BOOTING', 'MIGRATING', 'RECOVERING', 'READY', 'RUNNING'] as const;

export const SHUTDOWN_PHASES = ['DRAINING', 'CHECKPOINTING', 'CLOSING', 'STOPPED'] as const;

export type BootPhase = (typeof BOOT_PHASES)[number];
export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];
export type DaemonPhase = BootPhase | ShutdownPhase | 'FAILED';

export type StepStatus = 'implemented' | 'not_implemented';

export interface LifecycleStep {
  readonly id: string;
  readonly phase: BootPhase;
  readonly status: StepStatus;
  /** Stage that will implement the step, when known. */
  readonly owner?: string;
  readonly note: string;
}

/**
 * RUNTIME-LIFECYCLE §2 startup table, one entry per numbered step.
 * Order matters: it is the order the daemon walks (and the reverse of cleanup).
 */
export const STARTUP_STEPS: readonly LifecycleStep[] = [
  {
    id: 'config',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'explicit env config, no fallbacks',
  },
  {
    id: 'logging',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'structured JSON lines, content redacted',
  },
  {
    id: 'data_directory',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'directory + real write probe, no temp fallback',
  },
  {
    id: 'instance_lock',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'atomic, data-dir scoped, owner-checked release',
  },
  {
    id: 'sqlite_open',
    phase: 'BOOTING',
    status: 'implemented',
    note: 'single writer, WAL',
  },
  {
    id: 'migrations',
    phase: 'MIGRATING',
    status: 'implemented',
    note: 'packaged migrations, checksum verified',
  },
  {
    id: 'schema_verification',
    phase: 'MIGRATING',
    status: 'implemented',
    note: 'expected P1 shape, column order included',
  },
  {
    id: 'persona_recovery',
    phase: 'RECOVERING',
    status: 'implemented',
    note: 'normalize crashed personas; nothing is auto-started',
  },
  {
    id: 'runtime_recovery',
    phase: 'RECOVERING',
    status: 'implemented',
    note: 'recoverRuntime is fail-closed; no scheduler in this phase',
  },
  {
    id: 'event_bus',
    phase: 'READY',
    status: 'implemented',
    note: 'in-process ingress only; no transport and no external input',
  },
  {
    id: 'scheduler',
    phase: 'READY',
    status: 'implemented',
    note: 'running with an empty handler map; tasks are not dispatched',
  },
  {
    id: 'http_api',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-009',
    note: 'loopback API/WebSocket not implemented',
  },
  {
    id: 'health_check',
    phase: 'READY',
    status: 'not_implemented',
    owner: 'SH-009',
    note: 'no health transport; status is available in-process only',
  },
];

/** Capabilities this build can honestly claim. E1 has not assembled the Runtime. */
export interface DaemonCapabilities {
  readonly persistence: true;
  readonly migrations: true;
  readonly instanceLock: true;
  readonly structuredLogging: true;
  readonly runtime: 'not_implemented';
  readonly recovery: 'not_implemented';
  readonly eventBus: 'not_implemented';
  readonly scheduler: 'not_implemented';
  readonly httpApi: 'not_implemented';
  readonly healthEndpoint: 'not_implemented';
}

export const CAPABILITIES: DaemonCapabilities = Object.freeze({
  persistence: true,
  migrations: true,
  instanceLock: true,
  structuredLogging: true,
  runtime: 'not_implemented',
  recovery: 'not_implemented',
  eventBus: 'not_implemented',
  scheduler: 'not_implemented',
  httpApi: 'not_implemented',
  healthEndpoint: 'not_implemented',
});

/**
 * Four separate questions. None of them implies another:
 * assembled (the object exists), started (it was started), acceptsInput,
 * dispatchesTasks.
 */
export interface PersonaLifecycleSurface {
  readonly assembled: boolean;
  /** This batch never auto-starts personas, even after the object exists. */
  readonly autoStarted: false;
}

export interface EventBusSurface {
  readonly assembled: boolean;
  readonly initialized: boolean;
  readonly transport: 'none';
  readonly acceptsInput: false;
}

export interface SchedulerSurface {
  readonly assembled: boolean;
  readonly started: boolean;
  /** `absent` is the E1 fact: no scheduler object exists. */
  readonly state: 'absent' | 'created' | 'running' | 'stopping' | 'stopped';
  /** Fixed at 0 for this batch. Running does not mean a handler is registered. */
  readonly handlerKinds: 0;
  readonly dispatchesTasks: false;
}

export interface DaemonComponentSurface {
  readonly personaLifecycle: PersonaLifecycleSurface;
  readonly eventBus: EventBusSurface;
  readonly scheduler: SchedulerSurface;
  readonly httpApi: 'not_implemented';
  readonly healthEndpoint: 'not_implemented';
}

/**
 * Capability words for a later phase. E1's live report is still `CAPABILITIES`.
 * `scheduler: 'running'` is a different field from `taskDispatch`.
 */
export interface RuntimeCapabilitySurface {
  readonly persistence: true;
  readonly migrations: true;
  readonly instanceLock: true;
  readonly structuredLogging: true;
  readonly personaLifecycle: 'not_implemented' | 'assembled';
  readonly runtimeRecovery: 'not_implemented' | 'assembled';
  readonly eventBus: 'not_implemented' | 'assembled_no_transport';
  readonly eventIngress: 'not_implemented' | 'unavailable_no_transport';
  readonly scheduler: 'not_implemented' | 'running';
  readonly taskDispatch: 'not_implemented' | 'unavailable_no_handlers';
  readonly httpApi: 'not_implemented';
  readonly healthEndpoint: 'not_implemented';
}

export interface DaemonRuntimeSurface {
  readonly components: DaemonComponentSurface;
  readonly capabilities: RuntimeCapabilitySurface;
}

function freezeSurface(
  components: DaemonComponentSurface,
  capabilities: RuntimeCapabilitySurface,
): DaemonRuntimeSurface {
  return Object.freeze({
    components: Object.freeze({
      personaLifecycle: Object.freeze(components.personaLifecycle),
      eventBus: Object.freeze(components.eventBus),
      scheduler: Object.freeze(components.scheduler),
      httpApi: components.httpApi,
      healthEndpoint: components.healthEndpoint,
    }),
    capabilities: Object.freeze(capabilities),
  });
}

/**
 * What E1 can say. Nothing from the Runtime exists, so nothing is assembled
 * or started, and nothing accepts input or dispatches tasks.
 */
export const CURRENT_RUNTIME_SURFACE: DaemonRuntimeSurface = freezeSurface(
  {
    personaLifecycle: { assembled: false, autoStarted: false },
    eventBus: { assembled: false, initialized: false, transport: 'none', acceptsInput: false },
    scheduler: {
      assembled: false,
      started: false,
      state: 'absent',
      handlerKinds: 0,
      dispatchesTasks: false,
    },
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
  {
    persistence: true,
    migrations: true,
    instanceLock: true,
    structuredLogging: true,
    personaLifecycle: 'not_implemented',
    runtimeRecovery: 'not_implemented',
    eventBus: 'not_implemented',
    eventIngress: 'not_implemented',
    scheduler: 'not_implemented',
    taskDispatch: 'not_implemented',
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
);

/**
 * What a successful E2 boot can say. Persona recovery ran; nothing was
 * auto-started. Ingress and the scheduler do not exist. `runtimeRecovery:
 * 'assembled'` here means the recovery pass finished with `incomplete === null`,
 * not that a scheduler is running.
 */
export const RECOVERED_RUNTIME_SURFACE: DaemonRuntimeSurface = freezeSurface(
  {
    personaLifecycle: { assembled: true, autoStarted: false },
    eventBus: { assembled: false, initialized: false, transport: 'none', acceptsInput: false },
    scheduler: {
      assembled: false,
      started: false,
      state: 'absent',
      handlerKinds: 0,
      dispatchesTasks: false,
    },
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
  {
    persistence: true,
    migrations: true,
    instanceLock: true,
    structuredLogging: true,
    personaLifecycle: 'assembled',
    runtimeRecovery: 'assembled',
    eventBus: 'not_implemented',
    eventIngress: 'not_implemented',
    scheduler: 'not_implemented',
    taskDispatch: 'not_implemented',
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
);

/**
 * What a successful READY boot reports once the ingress and the scheduler
 * actually exist. `scheduler: 'running'` stays paired with
 * `taskDispatch: 'unavailable_no_handlers'` and `dispatchesTasks: false`.
 * Assigned only after both objects are up; not a static claim that every
 * capability in `CAPABILITIES` is implemented.
 */
export const READY_TARGET_SURFACE: DaemonRuntimeSurface = freezeSurface(
  {
    personaLifecycle: { assembled: true, autoStarted: false },
    eventBus: { assembled: true, initialized: true, transport: 'none', acceptsInput: false },
    scheduler: {
      assembled: true,
      started: true,
      state: 'running',
      handlerKinds: 0,
      dispatchesTasks: false,
    },
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
  {
    persistence: true,
    migrations: true,
    instanceLock: true,
    structuredLogging: true,
    personaLifecycle: 'assembled',
    runtimeRecovery: 'assembled',
    eventBus: 'assembled_no_transport',
    eventIngress: 'unavailable_no_transport',
    scheduler: 'running',
    taskDispatch: 'unavailable_no_handlers',
    httpApi: 'not_implemented',
    healthEndpoint: 'not_implemented',
  },
);
