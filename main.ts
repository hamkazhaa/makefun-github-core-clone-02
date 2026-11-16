// The entrypoint: bind an ephemeral port, register it with the suite, then wait
// until the suite says the trial is done. The forge itself lives in app.ts.
//
// Lifecycle (the wire contract in the kit's RULES.txt):
//   1. MAKEFUN_ENV_URL names the suite's origin. Without it there is nothing to
//      register with, so the program exits 1 at once.
//   2. Listen on port 0 (the kernel picks a free one). Never bind 8080: the suite
//      owns it.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The suite records the address
//      the request came from plus N as the base URL and dials it from then on.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then close
//      the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  // The harness may stop the trial at any moment: shut the server down
  // cleanly instead of leaving the port bound after the process is gone.
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server bound no TCP port');
  }
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((err: unknown) => {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
