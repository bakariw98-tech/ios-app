/**
 * Exercises buildApp with NO injected config — the one path every other test
 * skips. `makeApp` in test/helpers.ts always passes `config` directly, which
 * bypasses `buildConfig(c.env)` entirely, so the actual production startup
 * path (real Workers bindings, possibly missing or malformed) had never run
 * under test. That gap is exactly what let a live "server misconfigured" 500
 * go unexplained with no way to tell which secret was the problem.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppBindings } from '../src/app.js';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/lib/config.js';

const workingEnv: Env = {
  VAPI_API_KEY: 'abc123def456',
  VAPI_WEBHOOK_SECRET: 'a-long-random-secret',
  VAPI_PHONE_NUMBER: '+15551234567',
  PUBLIC_SERVER_URL: 'https://example.workers.dev',
  DB: {} as never,
};

function request(app: Hono<AppBindings>, env: Env) {
  return app.request('/health', {}, env);
}

describe('startup with real (uninjected) config', () => {
  it('serves normally when every secret is present and clean', async () => {
    const app = buildApp();
    const response = await request(app, workingEnv);
    expect(response.status).toBe(200);
  });

  it('names the single missing secret in the response body', async () => {
    const app = buildApp();
    const { VAPI_API_KEY: _drop, ...broken } = workingEnv;
    const response = await request(app, broken as Env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('server misconfigured');
    expect(body.detail).toMatch(/Missing required secret\(s\): VAPI_API_KEY/);
  });

  it('names every missing secret, not just the first', async () => {
    const app = buildApp();
    const {
      VAPI_API_KEY: _a,
      VAPI_WEBHOOK_SECRET: _b,
      ...broken
    } = workingEnv;
    const response = await request(app, broken as Env);
    const body = (await response.json()) as { detail: string };

    expect(body.detail).toMatch(/VAPI_API_KEY/);
    expect(body.detail).toMatch(/VAPI_WEBHOOK_SECRET/);
  });

  it('names a malformed secret without echoing its value', async () => {
    const app = buildApp();
    const response = await request(app, {
      ...workingEnv,
      VAPI_WEBHOOK_SECRET: 'super-secret-value ', // trailing space
    });

    const body = (await response.json()) as { detail: string };
    expect(body.detail).toMatch(
      /VAPI_WEBHOOK_SECRET has leading or trailing whitespace/,
    );
    expect(body.detail).not.toMatch(/super-secret-value/);
  });

  it('does NOT require VAPI_PHONE_NUMBER_ID to start', async () => {
    // Regression check for the earlier bug: this field was required for no
    // reason nothing in the codebase reads it.
    const app = buildApp();
    const response = await request(app, workingEnv); // no ID set at all
    expect(response.status).toBe(200);
  });
});
