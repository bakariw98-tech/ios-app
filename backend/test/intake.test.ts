/**
 * POST /intake/turn tests. OpenAI's Chat Completions endpoint is faked at the
 * `fetch` boundary, same pattern as test/realtime.test.ts. Confirms the
 * request shape, the cap-enforcement behavior, and that the real API key
 * never reaches a response body under any failure path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BriefSchema } from '../src/domain/inPersonBrief.js';
import { MAX_INTAKE_QUESTIONS, MAX_INTAKE_TURNS } from '../src/domain/inPersonIntake.js';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/store.js';
import { NO_ENV, testConfig } from './helpers.js';

const OPENAI_KEY = 'sk-test-real-key-do-not-leak';

const configWithOpenAi = { ...testConfig, openai: { apiKey: OPENAI_KEY } };

function makeApp() {
  return buildApp({ store: new MemoryStore(), config: configWithOpenAi });
}

/** Builds a fake Chat Completions response carrying the given structured-output object. */
function chatCompletionResponse(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Default: always replies with a question. Individual tests override as needed. */
function stubFetch(handler: (init: RequestInit) => Response) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === 'https://api.openai.com/v1/chat/completions') {
      return handler(init as RequestInit);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  stubFetch(() => chatCompletionResponse({ done: false, question: 'What size?', situation: null }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(body: unknown) {
  return makeApp().request(
    '/intake/turn',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    NO_ENV,
  );
}

describe('POST /intake/turn', () => {
  it('returns a question on the first turn', async () => {
    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      done: boolean;
      question: string | null;
      situation: string | null;
      situationSoFar: string;
      questionsAsked: number;
      questionsRemaining: number;
    };
    expect(body.done).toBe(false);
    expect(body.question).toBe('What size?');
    expect(body.situation).toBeNull();
    expect(body.situationSoFar).toContain('Order a coffee.');
    expect(body.questionsAsked).toBe(1);
    expect(body.questionsRemaining).toBe(MAX_INTAKE_QUESTIONS - 1);
  });

  it('authenticates to OpenAI with the real key, server-side only', async () => {
    await post({ situation: 'Order a coffee.' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it('requests strict json_schema structured output on the documented model', async () => {
    await post({ situation: 'Order a coffee.' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));

    expect(sent.response_format.type).toBe('json_schema');
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(typeof sent.model).toBe('string');
    expect(sent.model.length).toBeGreaterThan(0);
  });

  it('puts a system prompt first and the situation in the messages', async () => {
    await post({ situation: 'Ask for a table for two, outside if possible.' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));

    expect(sent.messages[0].role).toBe('system');
    expect(
      sent.messages.some((m: { content: string }) =>
        m.content.includes('Ask for a table for two, outside if possible.'),
      ),
    ).toBe(true);
  });

  it('returns done:true with the model\'s synthesized paragraph, not the mechanical roll-up', async () => {
    stubFetch(() =>
      chatCompletionResponse({
        done: true,
        question: null,
        situation: 'A well-written paragraph the model wrote.',
      }),
    );

    const response = await post({
      situation: 'Order a coffee.',
      turns: [
        { role: 'assistant', text: 'What size?' },
        { role: 'user', text: 'Medium.' },
      ],
    });
    const body = (await response.json()) as { done: boolean; situation: string };
    expect(body.done).toBe(true);
    expect(body.situation).toBe('A well-written paragraph the model wrote.');
  });

  // The cross-module guarantee: whatever comes back as `situation` on a done
  // reply must always be acceptable to the existing, unchanged BriefSchema —
  // this is what lets the enriched paragraph reach /realtime/session unchanged.
  it('clamps an oversized model paragraph so BriefSchema still accepts it', async () => {
    const long = 'a'.repeat(5000);
    stubFetch(() => chatCompletionResponse({ done: true, question: null, situation: long }));

    const response = await post({ situation: 'Order a coffee.' });
    const body = (await response.json()) as { situation: string };
    expect(body.situation.length).toBeLessThanOrEqual(4000);
    expect(BriefSchema.safeParse({ situation: body.situation }).success).toBe(true);
  });

  it('appends a finalize nudge once the question cap is reached', async () => {
    const turns = Array.from({ length: MAX_INTAKE_QUESTIONS }, (_, i) => [
      { role: 'assistant' as const, text: `Q${i}` },
      { role: 'user' as const, text: `A${i}` },
    ]).flat();

    await post({ situation: 'Order a coffee.', turns });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    const last = sent.messages[sent.messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toMatch(/used your last question/i);
  });

  it('forces done:true at the cap even if the model still says done:false', async () => {
    stubFetch(() => chatCompletionResponse({ done: false, question: 'One more thing?', situation: null }));

    const turns = Array.from({ length: MAX_INTAKE_QUESTIONS }, (_, i) => [
      { role: 'assistant' as const, text: `Q${i}` },
      { role: 'user' as const, text: `A${i}` },
    ]).flat();

    const response = await post({ situation: 'Order a coffee.', turns });
    const body = (await response.json()) as { done: boolean; question: string | null; situation: string };
    expect(body.done).toBe(true);
    expect(body.question).toBeNull();
    expect(body.situation.length).toBeGreaterThan(0);
    expect(BriefSchema.safeParse({ situation: body.situation }).success).toBe(true);
  });

  it('rejects an oversized turns array with 400, never calling OpenAI', async () => {
    const turns = Array.from({ length: MAX_INTAKE_TURNS + 1 }, (_, i) => ({
      role: i % 2 === 0 ? ('assistant' as const) : ('user' as const),
      text: 'x',
    }));
    const response = await post({ situation: 'test', turns });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
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
      '/intake/turn',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ situation: 'test' }),
      },
      NO_ENV,
    );
    expect(response.status).toBe(503);
  });

  it('returns 502 with OpenAI\'s own detail on a non-2xx response', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "The model 'gone-model' does not exist" } }),
          { status: 400 },
        ),
    );

    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain('400');
    expect(body.detail).toContain('does not exist');
  });

  it('returns 502 when the model content is not valid JSON', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }),
          { status: 200 },
        ),
    );
    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);
  });

  it('returns 502 when the model returns a refusal instead of content', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { refusal: 'I cannot help with that.' } }] }),
          { status: 200 },
        ),
    );
    const response = await post({ situation: 'Order a coffee.' });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toMatch(/declined/i);
  });

  it('never leaks the real API key when OpenAI itself fails', async () => {
    stubFetch(() => new Response('server error', { status: 500 }));
    const response = await post({ situation: 'Order a coffee.' });
    const text = await response.text();
    expect(text).not.toContain(OPENAI_KEY);
  });

  it('redacts the API key from the detail even if OpenAI echoes it back', async () => {
    stubFetch(() => new Response(`invalid key: ${OPENAI_KEY}`, { status: 401 }));
    const response = await post({ situation: 'Order a coffee.' });
    const text = await response.text();
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).toContain('[redacted]');
  });

  it('pins the response contract shape', async () => {
    const response = await post({ situation: 'Order a coffee.' });
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['done', 'question', 'questionsAsked', 'questionsRemaining', 'situation', 'situationSoFar'].sort(),
    );
  });
});
