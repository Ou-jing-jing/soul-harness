import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level,
      sink: (line: string) => lines.push(line),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
  };
}

describe('structured logging', () => {
  it('emits one JSON object per line with the bound context', () => {
    const { lines, logger } = capture();
    logger.child({ personaId: 'psn_x' }).info('phase_entered', { phase: 'RUNNING' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'phase_entered',
      personaId: 'psn_x',
      phase: 'RUNNING',
    });
  });

  it('redacts content-bearing keys at any depth', () => {
    const { lines, logger } = capture();
    logger.info('test', {
      token: 'secret-token',
      content: 'the persona said hello',
      payload: { nested: 'memory body' },
      memory: ['a fragment'],
      phase: 'RUNNING',
      deep: { apiKey: 'k', note: 'ok' },
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['token']).toBe('[redacted]');
    expect(record['content']).toBe('[redacted]');
    expect(record['payload']).toBe('[redacted]');
    expect(record['memory']).toBe('[redacted]');
    expect(record['phase']).toBe('RUNNING');
    expect(record['deep']).toBe('[redacted]');
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('the persona said hello');
    expect(lines[0]).not.toContain('memory body');
  });

  it('redacts free-text fields that are not on the allowlist', () => {
    const { lines, logger } = capture();
    const userInput = 'user said the secret phrase amber-otter';
    const modelOutput = 'model replied with amber-otter too';
    const privateConversation = 'private conversation amber-otter';

    logger.info('diagnostic', {
      message: userInput,
      detail: modelOutput,
      context: privateConversation,
      phase: 'RUNNING',
    });

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['message']).toBe('[redacted]');
    expect(record['detail']).toBe('[redacted]');
    expect(record['context']).toBe('[redacted]');
    expect(record['phase']).toBe('RUNNING');
    expect(lines[0]).not.toContain('amber-otter');
  });

  it('does not walk an unknown object far enough to leak a nested value', () => {
    const { lines, logger } = capture();
    logger.info('diagnostic', {
      context: { cause: { message: 'nested amber-otter', token: 'sk-live' } },
      history: ['amber-otter'],
    });

    expect(lines[0]).not.toContain('amber-otter');
    expect(lines[0]).not.toContain('sk-live');
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['context']).toBe('[redacted]');
    expect(record['history']).toBe('[redacted]');
  });

  it('redacts a plain error message while keeping name and a string code', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('boom'), {
      name: 'DaemonError',
      code: 'lock_held',
    });

    logger.error('fatal', { error });

    const record = JSON.parse(lines[0] as string) as { error?: Record<string, unknown> };
    expect(record.error).toStrictEqual({
      name: 'DaemonError',
      code: 'lock_held',
      message: '[redacted]',
    });
    expect(lines[0]).not.toContain('boom');
  });

  it('never serializes sensitive error text', () => {
    const { lines, logger } = capture();
    const secret = 'sk-live-SECRET-TOKEN-9f3e2a7c';
    const userText = 'the persona said my password is hunter2';
    const error = new Error(`Authorization: Bearer ${secret}; ${userText}`);

    logger.error('fatal', { error });

    const line = lines[0] as string;
    expect(line).not.toContain(secret);
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Authorization: Bearer');
    expect(JSON.parse(line)).toMatchObject({ error: { message: '[redacted]' } });
  });

  it('never writes an error stack', () => {
    const { lines, logger } = capture();
    const error = new Error('boom');
    const stackLine = error.stack?.split('\n')[1] ?? 'at ';

    logger.error('fatal', { error });

    const line = lines[0] as string;
    expect(line).not.toContain(stackLine);
    expect(line).not.toContain('.ts:');
    expect(line).not.toContain('at ');
  });

  it('redacts an unknown nested key even when it holds an error', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('nested boom'), { code: 'E_NESTED' });

    logger.error('fatal', { error: { cause: error } });

    const line = lines[0] as string;
    expect(line).not.toContain('nested boom');
    const record = JSON.parse(line) as { error?: { cause?: unknown } };
    expect(record.error).toStrictEqual({ cause: '[redacted]' });
  });

  it('filters by level', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toStrictEqual([
      'w',
      'e',
    ]);
  });
});
