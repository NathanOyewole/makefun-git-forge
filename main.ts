// Entry <-> env lifecycle. Kept separate from app.ts on purpose: app.ts is the contest's
// HTTP surface; this file only binds a port, tells the env where to reach us, waits for the
// env to say the trial is over, and exits cleanly. No package, built-in or model call beyond
// the fetch/AbortSignal/timers the lifecycle itself needs.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to register with,
//      so we fail fast with exit 1.
//   2. createApp() then listen(0): the kernel picks a free port. Never bind 8080 (the env owns it).
//   3. POST $MAKEFUN_ENV_URL/register {port}. The env records the caller's address plus the port
//      and dials us from then on. 200 is normal; 409 means another entry already won, and this
//      process just keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until {"done":true}. The answer is immediate ({"done":false}
//      while the suite runs), so this is a poll; a failed/slow poll is retried with backoff and
//      we never exit before the env says done.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First retry wait, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff for `attempt` failed requests, capped at RETRY_MAX_MS. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or another entry wins (409). */
async function register(port: number): Promise<void> {
  const maxAttempts = 200; // bound a permanently-unreachable env instead of retrying forever
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
      process.stderr.write(`[entry] register attempt ${attempt + 1}: HTTP ${res.status}, retrying\n`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      // Network error or a retryable status: the env may still be starting.
      process.stderr.write(`[entry] register attempt ${attempt + 1} failed, retrying\n`);
    }
    await sleep(retryDelay(attempt));
  }
  throw new Error(`register did not succeed after ${maxAttempts} attempts`);
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or a poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind, register, then serve until the env is done: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
