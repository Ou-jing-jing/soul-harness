/* global setImmediate */
/**
 * Test fixture: runs the real daemon entry and raises a signal *in-process*.
 *
 * Windows cannot deliver SIGINT/SIGTERM from one Node process to another
 * (`child.kill('SIGTERM')` terminates instead of signalling), so the graceful
 * path is exercised here: the fixture calls the real `run()` from the built
 * entry and, once the daemon reports the phase in `SOUL_TEST_SIGNAL_AT`
 * (default `RUNNING`), emits the same `process 'SIGTERM'`/`'SIGINT'` event
 * Node itself raises — which is exactly what the handler in `main.ts` sees.
 *
 * The signal name comes from SOUL_TEST_SIGNAL (default SIGTERM).
 */

import { run } from '../../dist/main.js';

const signal = process.env.SOUL_TEST_SIGNAL ?? 'SIGTERM';
const phase = process.env.SOUL_TEST_SIGNAL_AT ?? 'RUNNING';
const bootPhases = new Set(['MIGRATING', 'RECOVERING', 'READY', 'RUNNING']);
if (!bootPhases.has(phase)) {
  throw new Error(`SOUL_TEST_SIGNAL_AT must be a logged boot phase, got ${phase}`);
}
const marker = `"phase":"${phase}"`;
let sent = false;

const originalWrite = process.stdout.write.bind(process.stdout);
let buffer = '';

process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const result = originalWrite(chunk, ...rest);
  buffer += text;
  if (!sent && buffer.includes(marker)) {
    sent = true;
    setImmediate(() => {
      process.emit(signal);
    });
  }
  return result;
};

const code = await run();
process.exitCode = code;
