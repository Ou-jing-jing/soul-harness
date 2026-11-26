import { describe, expect, it } from 'vitest';

import {
  API_ASSEMBLED_SURFACE,
  API_DRAINING_SURFACE,
  API_FAILED_SURFACE,
  API_RUNNING_SURFACE,
  API_STOPPED_SURFACE,
  CAPABILITIES,
  CURRENT_RUNTIME_SURFACE,
  READY_TARGET_SURFACE,
  RECOVERED_RUNTIME_SURFACE,
  STARTUP_STEPS,
} from '../src/phases.js';

describe('startup steps stay honest', () => {
  it('marks recovery, ingress, scheduler, HTTP and health implemented', () => {
    expect(STARTUP_STEPS.map((step) => step.id)).toStrictEqual([
      'config',
      'logging',
      'data_directory',
      'instance_lock',
      'sqlite_open',
      'migrations',
      'schema_verification',
      'persona_recovery',
      'runtime_recovery',
      'event_bus',
      'scheduler',
      'http_api',
      'health_check',
    ]);
    for (const id of [
      'persona_recovery',
      'runtime_recovery',
      'event_bus',
      'scheduler',
      'http_api',
      'health_check',
    ]) {
      expect(STARTUP_STEPS.find((step) => step.id === id)?.status).toBe('implemented');
    }
    expect(STARTUP_STEPS.find((step) => step.id === 'http_api')?.owner).toBe('SH-009');
    expect(STARTUP_STEPS.find((step) => step.id === 'health_check')?.owner).toBe('SH-009');
  });
});

describe('runtime surface', () => {
  it('does not claim that any runtime component is assembled or started', () => {
    const current = CURRENT_RUNTIME_SURFACE;
    expect(current.components.personaLifecycle).toStrictEqual({
      assembled: false,
      autoStarted: false,
    });
    expect(current.components.eventBus).toStrictEqual({
      assembled: false,
      initialized: false,
      transport: 'none',
      acceptsInput: false,
    });
    expect(current.components.scheduler).toStrictEqual({
      assembled: false,
      started: false,
      state: 'absent',
      handlerKinds: 0,
      dispatchesTasks: false,
    });
    expect(current.capabilities.personaLifecycle).toBe('not_implemented');
    expect(current.capabilities.runtimeRecovery).toBe('not_implemented');
    expect(current.capabilities.eventBus).toBe('not_implemented');
    expect(current.capabilities.eventIngress).toBe('not_implemented');
    expect(current.capabilities.scheduler).toBe('not_implemented');
    expect(current.capabilities.taskDispatch).toBe('not_implemented');
    expect(current.capabilities.httpApi).toBe('not_implemented');
    expect(current.capabilities.healthEndpoint).toBe('not_implemented');
    expect(CAPABILITIES.runtime).toBe('not_implemented');
    expect(CAPABILITIES.recovery).toBe('not_implemented');
    expect(CAPABILITIES.eventBus).toBe('not_implemented');
    expect(CAPABILITIES.scheduler).toBe('not_implemented');
  });

  it('keeps a future running scheduler from meaning that tasks are dispatched', () => {
    const ready = READY_TARGET_SURFACE;
    expect(ready.components.personaLifecycle.autoStarted).toBe(false);
    expect(ready.components.eventBus.acceptsInput).toBe(false);
    expect(ready.components.eventBus.transport).toBe('none');
    expect(ready.capabilities.eventBus).toBe('assembled_no_transport');
    expect(ready.capabilities.eventIngress).toBe('unavailable_no_transport');
    expect(ready.capabilities.scheduler).toBe('running');
    expect(ready.components.scheduler.handlerKinds).toBe(0);
    expect(ready.components.scheduler.dispatchesTasks).toBe(false);
    expect(ready.capabilities.taskDispatch).toBe('unavailable_no_handlers');
    expect(ready.capabilities.httpApi).toBe('not_implemented');
    expect(ready.capabilities.healthEndpoint).toBe('not_implemented');
    expect(ready).not.toBe(CURRENT_RUNTIME_SURFACE);
    expect(CAPABILITIES.scheduler).toBe('not_implemented');
  });

  it('reports a finished recovery without a scheduler', () => {
    const recovered = RECOVERED_RUNTIME_SURFACE;
    expect(recovered.components.personaLifecycle).toEqual({ assembled: true, autoStarted: false });
    expect(recovered.components.eventBus.assembled).toBe(false);
    expect(recovered.components.eventBus.acceptsInput).toBe(false);
    expect(recovered.components.scheduler).toEqual({
      assembled: false,
      started: false,
      state: 'absent',
      handlerKinds: 0,
      dispatchesTasks: false,
    });
    expect(recovered.capabilities.personaLifecycle).toBe('assembled');
    expect(recovered.capabilities.runtimeRecovery).toBe('assembled');
    expect(recovered.capabilities.scheduler).toBe('not_implemented');
    expect(recovered.capabilities.taskDispatch).toBe('not_implemented');
    expect(recovered.capabilities.eventBus).toBe('not_implemented');
    expect(recovered.capabilities.httpApi).toBe('not_implemented');
    expect(recovered).not.toBe(CURRENT_RUNTIME_SURFACE);
    expect(recovered).not.toBe(READY_TARGET_SURFACE);
  });

  it('uses the frozen API/health component and capability states', () => {
    const cases = [
      [API_ASSEMBLED_SURFACE, 'assembled', 'unavailable'],
      [API_RUNNING_SURFACE, 'running', 'available'],
      [API_DRAINING_SURFACE, 'draining', 'draining'],
      [API_STOPPED_SURFACE, 'stopped', 'unavailable'],
      [API_FAILED_SURFACE, 'failed', 'unavailable'],
    ] as const;
    for (const [surface, component, capability] of cases) {
      expect(surface.components.httpApi).toBe(component);
      expect(surface.components.healthEndpoint).toBe(component);
      expect(surface.capabilities.httpApi).toBe(capability);
      expect(surface.capabilities.healthEndpoint).toBe(capability);
      expect(surface.components.scheduler.dispatchesTasks).toBe(false);
    }
  });
});
