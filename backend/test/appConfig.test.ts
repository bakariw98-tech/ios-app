/**
 * Exercises buildApp with NO injected config — the one path every other test
 * skips. `makeApp` in test/helpers.ts always passes `config` directly, which
 * bypasses `buildConfig(c.env)` entirely, so the actual production startup
 * path (real Workers bindings, possibly missing, partial, or malformed) had
 * never run under test. That gap is exactly what let a live "server
 * misconfigured" 500 go unexplained with no way to tell which secret was the
 * problem.
 *
 * Also the home for mode-decoupling regression tests (ADR-005): `/health`
 * must boot with either mode configured alone, both, or neither — it's only
 * feature-specific routes (`/vapi/webhook`, `/session/*`) that should ever
 * refuse to serve when their mode isn't set up.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppBindings } from '../src/app.js';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/lib/config.js';

const vapiEnv: Env = {
  VAPI_API_KEY: 'abc123def456',
  VAPI_WEBHOOK_SECRET: 'a-long-random-secret',
  VAPI_PHONE_NUMBER: '+15551234567',
  PUBLIC_SERVER_URL: 'https://example.workers.dev',
  DB: {} as never,
};

const openaiEnv: Env = {
  OPENAI_API_KEY: 'sk-test-abc123',
  DB: {} as never,
};

function request(app: Hono<AppBindings>, env: Env, path = '/health') {
  return app.request(path, {}, env);
}

describe('boots regardless of which mode is configured', () => {
  it('serves /health with neither mode configured', async () => {
    const app = buildApp();
    const response = await request(app, { DB: {} as never });
    expect(response.status).toBe(200);
  });

  it('serves /health with only Vapi (phone mode) configured', async () => {
    const app = buildApp();
    const response = await request(app, vapiEnv);
    expect(response.status).toBe(200);
  });

  it('serves /health with only OPENAI_API_KEY (in-person mode) configured', async () => {
    const app = buildApp();
    const response = await request(app, openaiEnv);
    expect(response.status).toBe(200);
  });

  it('serves /health with both modes configured', async () => {
    const app = buildApp();
    const response = await request(app, { ...vapiEnv, ...openaiEnv });
    expect(response.status).toBe(200);
  });

  it('does NOT require VAPI_PHONE_NUMBER_ID to start', async () => {
    // Regression check: this field was required for no reason nothing in the
    // codebase reads it.
    const app = buildApp();
    const response = await request(app, vapiEnv); // no ID set at all
    expect(response.status).toBe(200);
  });
});

describe('phone-mode routes refuse cleanly when Vapi is not configured', () => {
  it('/vapi/webhook answers 503, not a 500 crash', async () => {
    const app = buildApp();
    const response = await app.request(
      '/vapi/webhook',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { type: 'status-update' } }),
      },
      { DB: {} as never },
    );
    expect(response.status).toBe(503);
  });

  it('/session/start answers 503, not a 500 crash', async () => {
    const app = buildApp();
    const response = await request(app, { DB: {} as never }, '/session/start');
    expect(response.status).toBe(503);
  });
});

describe('malformed or partial config still fails loudly', () => {
  it('names every missing field in a partial Vapi setup', async () => {
    const app = buildApp();
    const { VAPI_API_KEY: _a, VAPI_WEBHOOK_SECRET: _b, ...broken } = vapiEnv;
    const response = await request(app, broken as Env);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('server misconfigured');
    expect(body.detail).toMatch(/VAPI_API_KEY/);
    expect(body.detail).toMatch(/VAPI_WEBHOOK_SECRET/);
  });

  it('names a malformed secret without echoing its value', async () => {
    const app = buildApp();
    const response = await request(app, {
      ...vapiEnv,
      VAPI_WEBHOOK_SECRET: 'super-secret-value ', // trailing space
    });

    const body = (await response.json()) as { detail: string };
    expect(body.detail).toMatch(
      /VAPI_WEBHOOK_SECRET has leading or trailing whitespace/,
    );
    expect(body.detail).not.toMatch(/super-secret-value/);
  });

  it('catches a malformed OPENAI_API_KEY the same way', async () => {
    const app = buildApp();
    const response = await request(app, {
      ...openaiEnv,
      OPENAI_API_KEY: 'sk-test ',
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toMatch(
      /OPENAI_API_KEY has leading or trailing whitespace/,
    );
  });
});
