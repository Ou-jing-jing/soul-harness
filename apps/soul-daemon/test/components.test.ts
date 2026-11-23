import { describe, expect, it } from 'vitest';

import type { RecoveryPolicy, SchedulerPolicy } from '@soul-harness/runtime';

import { adaptRuntimeLogger, runRuntimeRecovery, toRuntimeNow } from '../src/components.js';
import type { TaskPolicy } from '../src/config.js';
import type { DaemonOptions } from '../src/daemon.js';
import { createRecordingLogger } from './helpers/harness.js';

describe('recovery assembly boundary', () => {
  it('adapts the daemon clock and logger without copying policy fields', () => {
    const { logger, records } = createRecordingLogger();
    const adapted = adaptRuntimeLogger(logger);
    adapted.info('persona.transition', { personaId: 'psn_x', normalized: 1 });
    expect(records.some((record) => record['event'] === 'persona.transition')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('displayName');

    expect(toRuntimeNow(() => new Date(1_731_700_000_000))()).toBe(1_731_700_000_000);

    const policy = { maxAttempts: 3, retryBackoffMs: 1000 } as TaskPolicy;
    const recovery: RecoveryPolicy = policy;
    const scheduler: SchedulerPolicy = policy;
    expect(recovery).toBe(scheduler);
    expect(typeof runRuntimeRecovery).toBe('function');

    type RecoveryInput = Parameters<typeof runRuntimeRecovery>[0];
    type HasScan = 'maxScanQueries' extends keyof RecoveryInput ? true : false;
    type HasProbe = 'maxProbeQueries' extends keyof RecoveryInput ? true : false;
    type HasHandlers = 'handlers' extends keyof DaemonOptions ? true : false;
    const hasScan: HasScan = false;
    const hasProbe: HasProbe = false;
    const hasHandlers: HasHandlers = false;
    expect(hasScan).toBe(false);
    expect(hasProbe).toBe(false);
    expect(hasHandlers).toBe(false);
  });
});
