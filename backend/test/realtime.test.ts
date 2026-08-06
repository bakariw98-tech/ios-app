/**
 * /realtime/session tests. OpenAI's client-secret endpoint is faked at the
 * `fetch` boundary, same pattern as the Vapi webhook harness — see
 * test/lifecycle.test.ts. Confirms the request we actually send matches what
 * was verified against OpenAI's docs in src/lib/openaiRealtime.ts, and that
 * the real API key never reaches the response body under any failure path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/store.js';
import { NO_ENV, testConfig } from './helpers.js';

const OPENAI_KEY = 'sk-test-real-key-do-not-leak';
const CLIENT_SECRET = 'ek_fake_ephemeral_value';

const configWithOpenAi = { ...testConfig, openai: { apiKey: OPENAI_KEY } };

function makeApp() {
  return buildApp({ store: new MemoryStore(), config: configWithOpenAi });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === 'https://api.openai.com/v1/realtime/client_secrets') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({
          value: CLIENT_SECRET,
          expires_at: Math.floor(Date.now() / 1000) + 60,
          session: {
            model: body.session.model,
            audio: { output: { voice: body.session.audio.output.voice } },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(body: unknown) {
  return makeApp().request(
    '/realtime/session',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    NO_ENV,
  );
}

describe('POST /realtime/session', () => {
  it('mints a session and returns the client secret, not the real API key', async () => {
    const response = await post({ situation: 'Order a coffee, oat milk.' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      clientSecret: string;
      expiresAt: string;
      model: string;
      voice: string;
      correctionMarker: { prefix: string; suffix: string };
    };
    expect(body.clientSecret).toBe(CLIENT_SECRET);
    expect(body.clientSecret).not.toContain(OPENAI_KEY);
    expect(body.voice).toBe('cedar'); // default
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  // Every client (iOS today, the browser test client next) needs the exact
  // correction-marker format to recognise a typed correction as
  // authoritative rather than something the other person said. Sourcing it
  // from this response instead of a client-side hardcoded copy is what keeps
  // a third client from becoming a third place the string can drift out of
  // sync with domain/inPersonBrief.ts, which is what the model is actually
  // taught to recognise.
  it('includes the correction marker so clients never hardcode it', async () => {
    const response = await post({ situation: 'Order a coffee.' });
    const body = (await response.json()) as {
      correctionMarker: { prefix: string; suffix: string };
    };
    expect(body.correctionMarker).toEqual({
      prefix: 'TYPED CORRECTION FROM',
      suffix: 'NOT SPOKEN BY THE OTHER PERSON',
    });
  });

  it('authenticates to OpenAI with the real key, server-side only', async () => {
    await post({ situation: 'Order a coffee.' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it('sends the exact session shape verified against OpenAI docs', async () => {
    await post({ situation: 'Order a coffee.' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));

    expect(sent.session.type).toBe('realtime');
    expect(sent.session.output_modalities).toEqual(['audio']);
    expect(sent.session.audio.input.format).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
    expect(sent.session.audio.input.turn_detection.interrupt_response).toBe(
      true,
    );
    expect(sent.session.audio.output.voice).toBe('cedar');
    // A real request to OpenAI 400'd on exactly this being missing —
    // asserting only input.format (above) let it through, since input and
    // output are separate objects with independently required fields.
    expect(sent.session.audio.output.format).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
  });

  it('embeds the brief into the instructions sent to OpenAI', async () => {
    await post({ situation: 'Ask for a table for two, outside if possible.' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.session.instructions).toContain(
      'Ask for a table for two, outside if possible.',
    );
  });

  it('accepts an explicit voice override', async () => {
    const response = await post({ situation: 'Order a coffee.', voice: 'marin' });
    const body = (await response.json()) as { voice: string };
    expect(body.voice).toBe('marin');
  });

  it('ignores an invalid voice rather than forwarding it to OpenAI', async () => {
    await post({ situation: 'Order a coffee.', voice: 'nova' }); // not realtime-supported
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.session.audio.output.voice).toBe('cedar'); // fell back to default
  });

  it('rejects an empty situation with 400, never calling OpenAI', async () => {
    const response = await post({ situation: '' });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing body with 400', async () => {
    const response = await post({});
    expect(response.status).toBe(400);
  });

  it('returns 503 when in-person mode is not configured', async () => {
    const app = buildApp({ store: new MemoryStore(), config: testConfig }); // no openai
    const response = await app.request(
      '/realtime/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ situation: 'test' }),
      },
      NO_ENV,
    );
    expect(response.status).toBe(503);
  });

  it('never leaks the real API key when OpenAI itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500 })),
    );

    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);

    const text = await response.text();
    expect(text).not.toContain(OPENAI_KEY);
  });

  // Regression test for a real debug cycle: a retired model ID made every
  // session fail, and the response said only "could not start a realtime
  // session" — with no log-tailing tool available, the cause took a
  // docs-diffing detour to find. OpenAI's own rejection text has to reach the
  // caller or that repeats every time this breaks.
  it('surfaces OpenAI\'s own rejection text so failures are diagnosable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "The model 'gone-model' does not exist" } }),
            { status: 400 },
          ),
      ),
    );

    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);

    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain('400');
    expect(body.detail).toContain('does not exist');
  });

  // The detail field above carries OpenAI's response body verbatim, so the
  // no-leak guarantee can't rest on "OpenAI would never echo the key back."
  it('redacts the API key from the detail even if OpenAI echoes it back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(`invalid key: ${OPENAI_KEY}`, { status: 401 }),
      ),
    );

    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);

    const text = await response.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).toContain('[redacted]');
  });
});
