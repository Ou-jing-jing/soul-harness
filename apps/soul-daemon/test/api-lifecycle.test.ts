import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { SoulDaemon } from '../src/daemon.js';
import { isDaemonError } from '../src/errors.js';
import { API_TOKEN_FILE_NAME } from '../src/api/token.js';
import { LOCK_FILE_NAME } from '../src/lock.js';
import {
  createRecordingLogger,
  makeTempDir,
  removeTempDir,
  TEST_POLICY_ENV,
} from './helpers/harness.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    removeTempDir(dirs.pop() as string);
  }
});

function tempDir(): string {
  const dir = makeTempDir('sh-api-lifecycle-');
  dirs.push(dir);
  return dir;
}

function makeDaemon(dir: string): SoulDaemon {
  const config = loadConfig({ SOUL_DATA_DIR: dir, ...TEST_POLICY_ENV }, process.cwd());
  const { logger } = createRecordingLogger();
  return new SoulDaemon({ config, logger });
}

function apiToken(dir: string): string {
  return readFileSync(join(dir, API_TOKEN_FILE_NAME), 'utf8').replace(/\r?\n$/u, '');
}

describe('API lifecycle', () => {
  it('serves health/status only after listen and closes during shutdown', async () => {
    const dir = tempDir();
    const daemon = makeDaemon(dir);
    const report = await daemon.start();
    const token = apiToken(dir);

    expect(report.components.httpApi).toBe('running');
    expect(report.capabilities.httpApi).toBe('available');
    expect(report.capabilities.healthEndpoint).toBe('available');

    const health = await fetch('http://127.0.0.1:18700/v1/health/ready');
    expect(health.status).toBe(200);
    expect(await health.json()).toStrictEqual({ status: 'ready' });

    const status = await fetch('http://127.0.0.1:18700/v1/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain(dir);
    expect(statusText).not.toContain('lockPath');
    expect(statusText).not.toContain('dataDir');

    await daemon.stop('api-lifecycle');
    expect(daemon.status.storeOpen).toBe(false);
    expect(daemon.status.lockHeld).toBe(false);
    expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);

    await expect(fetch('http://127.0.0.1:18700/v1/health/live')).rejects.toBeTruthy();
  });

  it('fails closed when the fixed port is already occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(18700, '127.0.0.1', resolve);
    });

    try {
      const dir = tempDir();
      const daemon = makeDaemon(dir);
      const caught = await daemon.start().catch((error: unknown) => error);

      expect(isDaemonError(caught) && caught.code).toBe('http_api_start_failed');
      expect(daemon.phase).toBe('FAILED');
      expect(daemon.status.components.httpApi).toBe('failed');
      expect(daemon.status.capabilities.httpApi).toBe('unavailable');
      expect(daemon.status.storeOpen).toBe(false);
      expect(daemon.status.lockHeld).toBe(false);
      expect(existsSync(join(dir, LOCK_FILE_NAME))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
