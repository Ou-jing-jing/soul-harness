import { describe, expect, it } from 'vitest';

import { CONFIG_ENV_VARS, CONFIG_LIMITS, loadConfig } from '../src/config.js';
import { DAEMON_ERROR_CODES, isDaemonError } from '../src/errors.js';

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isDaemonError(error)) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

function detailsOf(run: () => unknown): Readonly<Record<string, string | number | boolean>> {
  try {
    run();
  } catch (error) {
    if (isDaemonError(error) && error.details !== undefined) {
      return error.details;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

/** The two variables that have no default. Existing cases that must reach later checks use this. */
function policyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [CONFIG_ENV_VARS.taskMaxAttempts]: '3',
    [CONFIG_ENV_VARS.taskRetryBackoffMs]: '1000',
    ...extra,
  };
}

describe('configuration is explicit', () => {
  it('fails when the data directory is absent instead of guessing one', () => {
    expect(codeOf(() => loadConfig({}, 'C:\\work'))).toBe('config_missing');
  });

  it('treats an empty or whitespace-only data directory as missing', () => {
    expect(codeOf(() => loadConfig({ [CONFIG_ENV_VARS.dataDir]: '   ' }, 'C:\\work'))).toBe(
      'config_missing',
    );
  });

  it('resolves a relative data directory against the working directory', () => {
    const config = loadConfig(
      { [CONFIG_ENV_VARS.dataDir]: 'soul-data', ...policyEnv() },
      'C:\\work',
    );
    expect(config.dataDir.endsWith('soul-data')).toBe(true);
    expect(config.dataDir.includes('soul-data')).toBe(true);
  });

  it('keeps an absolute data directory as given', () => {
    const absolute = process.platform === 'win32' ? 'C:\\soul-data' : '/soul-data';
    const config = loadConfig(
      { [CONFIG_ENV_VARS.dataDir]: absolute, ...policyEnv() },
      'C:\\ignored',
    );
    expect(config.dataDir).toBe(absolute);
  });

  it('rejects an unknown log level', () => {
    expect(
      codeOf(() =>
        loadConfig({ [CONFIG_ENV_VARS.dataDir]: 'x', [CONFIG_ENV_VARS.logLevel]: 'verbose' }),
      ),
    ).toBe('config_invalid');
  });

  it('rejects an out-of-range or non-numeric shutdown timeout', () => {
    for (const value of ['0', '99', '600001', '-5', 'abc', '1.5']) {
      expect(
        codeOf(() =>
          loadConfig({
            [CONFIG_ENV_VARS.dataDir]: 'x',
            [CONFIG_ENV_VARS.shutdownTimeoutMs]: value,
          }),
        ),
        value,
      ).toBe('config_invalid');
    }
  });

  it('applies documented defaults for optional values', () => {
    const config = loadConfig({ [CONFIG_ENV_VARS.dataDir]: 'x', ...policyEnv() });
    expect(config.logLevel).toBe('info');
    expect(config.shutdownTimeoutMs).toBe(CONFIG_LIMITS.shutdownTimeoutMs.fallback);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('accepts an in-range timeout', () => {
    const config = loadConfig({
      [CONFIG_ENV_VARS.dataDir]: 'x',
      [CONFIG_ENV_VARS.shutdownTimeoutMs]: '2500',
      ...policyEnv(),
    });
    expect(config.shutdownTimeoutMs).toBe(2500);
  });
});

describe('required task policy', () => {
  const names = [CONFIG_ENV_VARS.taskMaxAttempts, CONFIG_ENV_VARS.taskRetryBackoffMs] as const;

  it('rejects each required variable when it is missing', () => {
    for (const name of names) {
      const env = policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x' });
      delete env[name];
      expect(
        codeOf(() => loadConfig(env)),
        name,
      ).toBe('config_missing');
      expect(detailsOf(() => loadConfig(env))['variable']).toBe(name);
    }
  });

  it('treats an empty or whitespace-only required value as missing', () => {
    for (const name of names) {
      for (const blank of ['', '   ']) {
        const env = policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x', [name]: blank });
        expect(
          codeOf(() => loadConfig(env)),
          `${name}:${JSON.stringify(blank)}`,
        ).toBe('config_missing');
      }
    }
  });

  it('accepts the minimum and maximum of each required variable', () => {
    const attempts = CONFIG_LIMITS.taskMaxAttempts;
    const backoff = CONFIG_LIMITS.taskRetryBackoffMs;
    const low = loadConfig({
      [CONFIG_ENV_VARS.dataDir]: 'x',
      [CONFIG_ENV_VARS.taskMaxAttempts]: String(attempts.min),
      [CONFIG_ENV_VARS.taskRetryBackoffMs]: String(backoff.min),
    });
    const high = loadConfig({
      [CONFIG_ENV_VARS.dataDir]: 'x',
      [CONFIG_ENV_VARS.taskMaxAttempts]: String(attempts.max),
      [CONFIG_ENV_VARS.taskRetryBackoffMs]: String(backoff.max),
    });
    expect(low.policy).toStrictEqual({ maxAttempts: attempts.min, retryBackoffMs: backoff.min });
    expect(high.policy).toStrictEqual({ maxAttempts: attempts.max, retryBackoffMs: backoff.max });
  });

  it('rejects values outside the range, decimals, and non-numeric text', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [CONFIG_ENV_VARS.taskMaxAttempts, '0'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '101'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '1.5'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '3.0'],
      [CONFIG_ENV_VARS.taskMaxAttempts, 'abc'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '1e1'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '+3'],
      [CONFIG_ENV_VARS.taskMaxAttempts, '-1'],
      [CONFIG_ENV_VARS.taskRetryBackoffMs, '-1'],
      [CONFIG_ENV_VARS.taskRetryBackoffMs, '86400001'],
      [CONFIG_ENV_VARS.taskRetryBackoffMs, '1.5'],
      [CONFIG_ENV_VARS.taskRetryBackoffMs, 'nope'],
      [CONFIG_ENV_VARS.taskRetryBackoffMs, '9007199254740993'],
    ];
    for (const [name, value] of cases) {
      const env = policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x', [name]: value });
      expect(
        codeOf(() => loadConfig(env)),
        `${name}=${value}`,
      ).toBe('config_invalid');
      const details = detailsOf(() => loadConfig(env));
      expect(details['variable']).toBe(name);
      expect(JSON.stringify(details)).not.toContain(`"${value}"`);
    }
  });

  it('trims surrounding whitespace but does not clamp', () => {
    const config = loadConfig(
      policyEnv({
        [CONFIG_ENV_VARS.dataDir]: 'x',
        [CONFIG_ENV_VARS.taskMaxAttempts]: '  4 ',
      }),
    );
    expect(config.policy.maxAttempts).toBe(4);
  });
});

describe('optional recovery, scheduler and ingress budgets', () => {
  const optional = [
    {
      name: CONFIG_ENV_VARS.recoveryBatchSize,
      limit: CONFIG_LIMITS.recoveryBatchSize,
      read: (config: ReturnType<typeof loadConfig>): number => config.recovery.batchSize,
    },
    {
      name: CONFIG_ENV_VARS.recoveryMaxRows,
      limit: CONFIG_LIMITS.recoveryMaxRows,
      read: (config: ReturnType<typeof loadConfig>): number => config.recovery.maxRowsPerRun,
    },
    {
      name: CONFIG_ENV_VARS.recoveryMaxPersonas,
      limit: CONFIG_LIMITS.recoveryMaxPersonas,
      read: (config: ReturnType<typeof loadConfig>): number => config.recovery.maxPersonasPerRun,
    },
    {
      name: CONFIG_ENV_VARS.schedulerMaxTotal,
      limit: CONFIG_LIMITS.schedulerMaxTotal,
      read: (config: ReturnType<typeof loadConfig>): number => config.scheduler.maxConcurrentTotal,
    },
    {
      name: CONFIG_ENV_VARS.schedulerPerUnit,
      limit: CONFIG_LIMITS.schedulerPerUnit,
      read: (config: ReturnType<typeof loadConfig>): number =>
        config.scheduler.perPersonaChannelConcurrency,
    },
    {
      name: CONFIG_ENV_VARS.ingressQueueCapacity,
      limit: CONFIG_LIMITS.ingressQueueCapacity,
      read: (config: ReturnType<typeof loadConfig>): number => config.ingress.queueCapacity,
    },
    {
      name: CONFIG_ENV_VARS.ingressBufferTtlMs,
      limit: CONFIG_LIMITS.ingressBufferTtlMs,
      read: (config: ReturnType<typeof loadConfig>): number => config.ingress.bufferTtlMs,
    },
    {
      name: CONFIG_ENV_VARS.ingressPersonaCapacity,
      limit: CONFIG_LIMITS.ingressPersonaCapacity,
      read: (config: ReturnType<typeof loadConfig>): number =>
        config.ingress.personaAdmissionCapacity,
    },
  ] as const;

  it('uses the documented default when the variable is absent or blank', () => {
    const config = loadConfig(policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x' }));
    for (const item of optional) {
      expect(item.read(config), item.name).toBe(item.limit.fallback);
      const blank = loadConfig(policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x', [item.name]: '   ' }));
      expect(item.read(blank), item.name).toBe(item.limit.fallback);
    }
  });

  it('accepts each minimum and maximum and rejects the neighbours', () => {
    for (const item of optional) {
      const low = loadConfig(
        policyEnv({
          [CONFIG_ENV_VARS.dataDir]: 'x',
          [item.name]: String(item.limit.min),
        }),
      );
      const high = loadConfig(
        policyEnv({
          [CONFIG_ENV_VARS.dataDir]: 'x',
          [item.name]: String(item.limit.max),
        }),
      );
      expect(item.read(low), item.name).toBe(item.limit.min);
      expect(item.read(high), item.name).toBe(item.limit.max);
      for (const bad of [String(item.limit.min - 1), String(item.limit.max + 1), '1.5', 'abc']) {
        expect(
          codeOf(() => loadConfig(policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x', [item.name]: bad }))),
          `${item.name}=${bad}`,
        ).toBe('config_invalid');
      }
    }
  });
});

describe('configuration objects stay frozen', () => {
  it('freezes the outer config and each nested group', () => {
    const config = loadConfig(policyEnv({ [CONFIG_ENV_VARS.dataDir]: 'x' }));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.policy)).toBe(true);
    expect(Object.isFrozen(config.recovery)).toBe(true);
    expect(Object.isFrozen(config.scheduler)).toBe(true);
    expect(Object.isFrozen(config.ingress)).toBe(true);
  });
});

describe('error code set', () => {
  it('adds the assembly codes and does not add a shutdown timeout', () => {
    for (const code of [
      'persona_recovery_failed',
      'runtime_recovery_failed',
      'recovery_incomplete',
      'event_bus_start_failed',
      'scheduler_start_failed',
    ]) {
      expect(DAEMON_ERROR_CODES).toContain(code);
    }
    expect(DAEMON_ERROR_CODES).toContain('startup_failed');
    expect(DAEMON_ERROR_CODES).toContain('shutdown_failed');
    expect(DAEMON_ERROR_CODES).not.toContain('shutdown_timeout');
  });
});
