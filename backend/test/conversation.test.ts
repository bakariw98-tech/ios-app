/**
 * The conversation engine's routes.
 *
 * Fakes OpenAI at the `fetch` boundary, same as intake.test.ts and
 * realtime.test.ts — nothing here makes a real call. Whether the prompts
 * actually work is measured in `evals/`; what this file protects is the route
 * contract around them: the question cap the model is never trusted to
 * respect, the fact that a finished interview produces an intent in the same
 * response, and that the negotiator prompt is what actually reaches OpenAI.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ConversationIntent } from '../src/domain/conversationIntent.js';
import { MAX_INTERVIEW_QUESTIONS } from '../src/domain/conversationInterview.js';
import type { Config } from '../src/lib/config.js';
import { MemoryStore } from '../src/lib/store.js';

const config: Config = { openai: { apiKey: 'sk-test-secret' } };

function makeApp(c: Config = config) {
  return buildApp({ store: new MemoryStore(), config: c });
}

const intent: ConversationIntent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'friend',
  goal: 'Alex agrees to meet up in person',
  context: 'They fell out in March over the lease.',
  feelings: 'Sad and tired of the silence.',
  mustSay: ['I should have called sooner'],
  neverSay: ['the diagnosis'],
  acceptableCompromises: ['a phone call instead of meeting'],
  hardLimits: ['paying the full amount at once'],
  questionsToAnswer: ['Does Alex still want to be friends?'],
  tone: 'warm',
};

/** Queues one JSON body per outgoing fetch, in order, and records the requests. */
function stubOpenAi(bodies: unknown[]) {
  const requests: Array<{ url: string; body: any }> = [];
  let i = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const next = bodies[i++];
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return requests;
}

/** Chat Completions wraps structured output as a JSON string inside message.content. */
const asCompletion = (payload: unknown) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
});

const turn = (path: string, body: unknown) =>
  new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /conversation/turn — configuration and validation', () => {
  it('503s when OpenAI is not configured', async () => {
    const res = await makeApp({}).fetch(
      turn('/conversation/turn', { situation: 'hi' }),
      {} as never,
    );
    expect(res.status).toBe(503);
  });

  it('400s on an invalid body before making any OpenAI call', async () => {
    const requests = stubOpenAi([]);
    const res = await makeApp().fetch(
      turn('/conversation/turn', { situation: '' }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('400s on a turns array past the cap without calling OpenAI', async () => {
    const requests = stubOpenAi([]);
    const tooMany = Array.from({ length: MAX_INTERVIEW_QUESTIONS * 2 + 2 }, () => ({
      role: 'user',
      text: 'x',
    }));
    const res = await makeApp().fetch(
      turn('/conversation/turn', { situation: 'hi', turns: tooMany }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe('POST /conversation/turn — asking', () => {
  it('returns the question and the remaining budget', async () => {
    stubOpenAi([
      asCompletion({ done: false, question: 'What would make this worth having?' }),
    ]);

    const res = await makeApp().fetch(
      turn('/conversation/turn', { situation: 'I need to talk to Alex.' }),
      {} as never,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.done).toBe(false);
    expect(body.question).toBe('What would make this worth having?');
    expect(body.intent).toBeNull();
    expect(body.questionsAsked).toBe(1);
    expect(body.questionsRemaining).toBe(MAX_INTERVIEW_QUESTIONS - 1);
    vi.unstubAllGlobals();
  });

  it('makes exactly one OpenAI call while still asking', async () => {
    const requests = stubOpenAi([asCompletion({ done: false, question: 'Why now?' })]);
    await makeApp().fetch(
      turn('/conversation/turn', { situation: 'Something hard.' }),
      {} as never,
    );
    expect(requests).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('POST /conversation/turn — finishing', () => {
  it('extracts the intent in the same response when the model says done', async () => {
    const requests = stubOpenAi([
      asCompletion({ done: true, question: null }),
      asCompletion(intent),
    ]);

    const res = await makeApp().fetch(
      turn('/conversation/turn', {
        situation: 'I need to talk to Alex.',
        userFirstName: 'Sam',
        turns: [
          { role: 'assistant', text: 'What do you want to walk away with?' },
          { role: 'user', text: 'I want to see her.' },
        ],
      }),
      {} as never,
    );
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.done).toBe(true);
    expect(body.intent.goal).toBe(intent.goal);
    expect(body.intent.hardLimits).toEqual(intent.hardLimits);
    expect(requests).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('raises the token ceiling for extraction so the object cannot truncate mid-JSON', async () => {
    const requests = stubOpenAi([
      asCompletion({ done: true, question: null }),
      asCompletion(intent),
    ]);
    await makeApp().fetch(
      turn('/conversation/turn', { situation: 'x' }),
      {} as never,
    );
    // The interview turn keeps the shared default; extraction must not.
    expect(requests[1]!.body.max_completion_tokens).toBeGreaterThan(
      requests[0]!.body.max_completion_tokens,
    );
    vi.unstubAllGlobals();
  });

  it('forces extraction at the cap even when the model insists on another question', async () => {
    // The model is deliberately non-compliant here: it returns a question
    // after being told it has none left. The route must extract anyway.
    const requests = stubOpenAi([
      asCompletion({ done: false, question: 'One more thing?' }),
      asCompletion(intent),
    ]);

    const turns = Array.from({ length: MAX_INTERVIEW_QUESTIONS }, (_, i) => [
      { role: 'assistant', text: `q${i}` },
      { role: 'user', text: `a${i}` },
    ]).flat();

    const res = await makeApp().fetch(
      turn('/conversation/turn', { situation: 'x', turns }),
      {} as never,
    );
    const body = (await res.json()) as any;

    expect(body.done).toBe(true);
    expect(body.question).toBeNull();
    expect(body.intent).not.toBeNull();
    expect(requests).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('sends the finalize nudge once the cap is reached', async () => {
    const requests = stubOpenAi([
      asCompletion({ done: true, question: null }),
      asCompletion(intent),
    ]);
    const turns = Array.from({ length: MAX_INTERVIEW_QUESTIONS }, (_, i) => [
      { role: 'assistant', text: `q${i}` },
      { role: 'user', text: `a${i}` },
    ]).flat();

    await makeApp().fetch(turn('/conversation/turn', { situation: 'x', turns }), {} as never);

    const lastMessage = requests[0]!.body.messages.at(-1);
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toMatch(/last question/i);
    vi.unstubAllGlobals();
  });

  it('502s with a truncated detail when extraction returns an unusable shape', async () => {
    stubOpenAi([
      asCompletion({ done: true, question: null }),
      asCompletion({ goal: 'missing everything else' }),
    ]);
    const res = await makeApp().fetch(
      turn('/conversation/turn', { situation: 'x' }),
      {} as never,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/could not build/i);
    expect(body.detail.length).toBeLessThanOrEqual(501);
    vi.unstubAllGlobals();
  });
});

describe('POST /conversation/session', () => {
  const secretResponse = {
    value: 'ek_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    session: { model: 'gpt-realtime-2.1', audio: { output: { voice: 'cedar' } } },
  };

  it('503s when OpenAI is not configured', async () => {
    const res = await makeApp({}).fetch(
      turn('/conversation/session', { intent }),
      {} as never,
    );
    expect(res.status).toBe(503);
  });

  it('400s when the intent is missing or malformed', async () => {
    const requests = stubOpenAi([]);
    const res = await makeApp().fetch(
      turn('/conversation/session', { intent: { goal: 'incomplete' } }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('sends the negotiator prompt — goal, compromises and limits all reach OpenAI', async () => {
    const requests = stubOpenAi([secretResponse]);
    await makeApp().fetch(turn('/conversation/session', { intent }), {} as never);

    const instructions = requests[0]!.body.session.instructions as string;
    expect(instructions).toContain(intent.goal);
    expect(instructions).toContain(intent.hardLimits[0]!);
    expect(instructions).toContain(intent.neverSay[0]!);
    expect(instructions).toContain(intent.acceptableCompromises[0]!);
    // The behaviour that separates this from the relay prompt.
    expect(instructions).toMatch(/Adapt\s+—\s+do\s+not\s+repeat/i);
    vi.unstubAllGlobals();
  });

  it('uses the in-person escalation channel and its correction marker', async () => {
    const requests = stubOpenAi([secretResponse]);
    const res = await makeApp().fetch(
      turn('/conversation/session', { intent }),
      {} as never,
    );
    const instructions = requests[0]!.body.session.instructions as string;
    expect(instructions).toContain('TYPED CORRECTION FROM');

    const body = (await res.json()) as any;
    expect(body.correctionMarker.prefix).toBe('TYPED CORRECTION FROM');
    expect(body.correctionMarker.suffix).toBe('NOT SPOKEN BY THE OTHER PERSON');
    vi.unstubAllGlobals();
  });

  it('returns the client secret, never the real API key', async () => {
    stubOpenAi([secretResponse]);
    const res = await makeApp().fetch(
      turn('/conversation/session', { intent }),
      {} as never,
    );
    const text = await res.text();
    expect(text).toContain('ek_test_123');
    expect(text).not.toContain('sk-test-secret');
    vi.unstubAllGlobals();
  });

  it('never leaks the API key in an error detail', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('bad key sk-test-secret', { status: 401 }),
    );
    const res = await makeApp().fetch(
      turn('/conversation/session', { intent }),
      {} as never,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk-test-secret');
    vi.unstubAllGlobals();
  });
});

describe('POST /conversation/interview-session — the spoken interview', () => {
  const secretResponse = {
    value: 'ek_interview_123',
    expires_at: Math.floor(Date.now() / 1000) + 60,
    session: { model: 'gpt-realtime-2.1', audio: { output: { voice: 'cedar' } } },
  };

  it('503s when OpenAI is not configured', async () => {
    const res = await makeApp({}).fetch(
      turn('/conversation/interview-session', {}),
      {} as never,
    );
    expect(res.status).toBe(503);
  });

  it('registers the finish tool — a voice session has no done flag to set', async () => {
    const requests = stubOpenAi([secretResponse]);
    const res = await makeApp().fetch(
      turn('/conversation/interview-session', { userFirstName: 'Sam' }),
      {} as never,
    );

    const session = requests[0]!.body.session;
    expect(session.tools).toHaveLength(1);
    expect(session.tools[0].name).toBe('finish_interview');
    expect(session.tool_choice).toBe('auto');

    // Returned so the client watches for the tool the server actually
    // registered, rather than hardcoding a second copy of the name.
    const body = (await res.json()) as any;
    expect(body.finishToolName).toBe('finish_interview');
  });

  it('turns on input transcription — without it the transcript has no answers', async () => {
    const requests = stubOpenAi([secretResponse]);
    await makeApp().fetch(
      turn('/conversation/interview-session', {}),
      {} as never,
    );
    expect(requests[0]!.body.session.audio.input.transcription).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('sends the spoken interview prompt, not the typed one', async () => {
    const requests = stubOpenAi([secretResponse]);
    await makeApp().fetch(
      turn('/conversation/interview-session', { userFirstName: 'Sam' }),
      {} as never,
    );
    const instructions = requests[0]!.body.session.instructions as string;
    expect(instructions).toMatch(/This is a spoken conversation/i);
    expect(instructions).toMatch(/finish_interview/);
    // The shared substance still has to be there.
    expect(instructions).toContain('"What do you want me to say?"');
    expect(instructions).toMatch(/Three things are non-negotiable/i);
    vi.unstubAllGlobals();
  });

  it('never leaks the API key on failure', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('bad key sk-test-secret', { status: 401 }),
    );
    const res = await makeApp().fetch(
      turn('/conversation/interview-session', {}),
      {} as never,
    );
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sk-test-secret');
    vi.unstubAllGlobals();
  });
});

describe('POST /conversation/extract', () => {
  it('503s when OpenAI is not configured', async () => {
    const res = await makeApp({}).fetch(
      turn('/conversation/extract', { turns: [{ role: 'user', text: 'hi' }] }),
      {} as never,
    );
    expect(res.status).toBe(503);
  });

  it('400s on an empty transcript without calling OpenAI', async () => {
    const requests = stubOpenAi([]);
    const res = await makeApp().fetch(
      turn('/conversation/extract', { turns: [] }),
      {} as never,
    );
    expect(res.status).toBe(400);
    expect(requests).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('returns the intent built from a spoken transcript', async () => {
    const requests = stubOpenAi([asCompletion(intent)]);
    const res = await makeApp().fetch(
      turn('/conversation/extract', {
        userFirstName: 'Sam',
        turns: [
          { role: 'assistant', text: "What's going on?" },
          { role: 'user', text: 'I need to fix things with Alex.' },
        ],
      }),
      {} as never,
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.intent.goal).toBe(intent.goal);
    // Warned about speech artefacts, and given the raised ceiling.
    expect(requests[0]!.body.messages[1].content).toMatch(/false starts and filler/i);
    expect(requests[0]!.body.max_completion_tokens).toBeGreaterThan(400);
    vi.unstubAllGlobals();
  });
});
