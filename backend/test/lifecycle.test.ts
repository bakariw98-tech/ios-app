/**
 * End-to-end lifecycle tests.
 *
 * Drives the real webhook through a whole call — interview, arming, the
 * recipient arriving, handoff with intent extraction, end-of-call analysis —
 * with Vapi faked at the `fetch` boundary and the store in memory. Nothing here
 * talks to the network or to D1.
 *
 * This is the harness that should catch a state-machine bug before it burns a
 * real call, so the failure paths get as much attention as the happy one.
 */

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppBindings } from '../src/app.js';
import { buildDisclosure } from '../src/domain/disclosure.js';
import type { Intent } from '../src/domain/intent.js';
import { MemoryStore } from '../src/lib/store.js';
import { CALL_ID, CONTROL_URL, NO_ENV, SECRET, makeApp } from './helpers.js';

/** Everything the fake Vapi was asked to do, in order. */
let controlCalls: Array<{ type: string; content?: string }> = [];

let app: Hono<AppBindings>;
let store: MemoryStore;

const intent: Intent = {
  userFirstName: 'Sam',
  recipientName: 'Alex',
  relationship: 'friend',
  situation: 'They fell out over a shared lease.',
  feelings: 'Sad and tired of the silence.',
  pointsToConvey: ['Sam misses them', 'Sam is sorry about how it ended'],
  desiredOutcome: 'Alex agrees to meet up.',
  mustSay: ['I should have called sooner'],
  neverSay: ['the money'],
  questionsToAsk: ['Would they be open to meeting?'],
  tone: 'warm',
};

function post(message: Record<string, unknown>, secret = SECRET) {
  return app.request(
    '/vapi/webhook',
    {
      method: 'POST',
      headers: { 'x-vapi-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { call: { id: CALL_ID }, ...message } }),
    },
    NO_ENV,
  );
}

const transcript = (role: 'user' | 'assistant', text: string) =>
  post({ type: 'transcript', role, transcriptType: 'final', transcript: text });

const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  post({
    type: 'tool-calls',
    toolCalls: [{ id: 'tc_1', function: { name, arguments: args } }],
  });

const handoff = (variableValues: unknown) =>
  post({ type: 'handoff-destination-request', variableValues });

beforeEach(async () => {
  controlCalls = [];
  store = new MemoryStore();
  app = makeApp(store);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(CONTROL_URL)) {
        controlCalls.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response('{}', { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }),
  );

  // Vapi hands us the control URL on the first status update.
  await post({
    type: 'status-update',
    status: 'in-progress',
    call: { id: CALL_ID, monitor: { controlUrl: CONTROL_URL } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the happy path', () => {
  it('runs interview → arm → recipient joins → handoff → summary', async () => {
    // --- Interview ---
    await transcript('user', 'I want to reach out to Alex about the lease.');
    expect((await store.get(CALL_ID))?.phase).toBe('interviewing');

    // --- User starts merging ---
    const armed = await toolCall('arm_for_merge', { userFirstName: 'Sam' });
    expect(armed.status).toBe(200);
    expect((await store.get(CALL_ID))?.phase).toBe('awaiting_recipient');
    expect((await store.get(CALL_ID))?.userFirstName).toBe('Sam');

    // Coaching during the window is fine and must not trip the backstop.
    await transcript('assistant', 'Tap Add Call — I’ll still be here.');
    expect(controlCalls).toHaveLength(0);

    // --- Handoff, model-initiated (it heard Alex) ---
    const response = await handoff(intent);
    const destination = ((await response.json()) as any).destination;

    expect(destination.type).toBe('assistant');
    // The disclosure is the first thing the recipient hears.
    expect(destination.assistant.firstMessage).toBe(buildDisclosure('Sam'));
    expect(destination.assistant.firstMessageMode).toBe(
      'assistant-speaks-first',
    );

    const record = (await store.get(CALL_ID))!;
    expect(record.phase).toBe('delegating');
    expect(record.disclosureDelivered).toBe(true);
    expect(record.intent?.neverSay).toContain('the money');

    // The backstop never had to fire.
    expect(controlCalls).toHaveLength(0);

    // --- End of call ---
    await post({
      type: 'end-of-call-report',
      endedReason: 'hangup',
      analysis: {
        summary: 'You told Alex you missed them. They agreed to meet Saturday.',
        structuredData: {
          disclosureDelivered: true,
          consentObtained: true,
          pointsCommunicated: ['Sam misses them'],
          recipientReaction: 'receptive',
          goalAchieved: true,
          boundariesRespected: true,
        },
      },
    });

    const finished = (await store.get(CALL_ID))!;
    expect(finished.phase).toBe('ended');
    expect(finished.summary?.summary).toMatch(/agreed to meet Saturday/);
  });

  it('records the transcript in order', async () => {
    await transcript('assistant', 'What’s going on?');
    await transcript('user', 'It’s about Alex.');

    const lines = await store.getTranscript(CALL_ID);
    expect(lines.map((l) => l.text)).toEqual([
      'What’s going on?',
      'It’s about Alex.',
    ]);
  });
});

describe('the backstop', () => {
  it('speaks the disclosure when the model misses the recipient arriving', async () => {
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });

    // Alex picks up. The model should hand off here — pretend it didn't.
    await transcript('user', 'Hello?');

    expect(controlCalls).toEqual([
      {
        type: 'say',
        content: buildDisclosure('Sam'),
        endCallAfterSpoken: false,
      },
    ]);

    const record = (await store.get(CALL_ID))!;
    expect(record.backstopFired).toBe(true);
    expect(record.handoffTrigger).toBe('server_backstop');
  });

  it('speaks the disclosure when the assistant breaks quiet mode', async () => {
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });
    await transcript(
      'assistant',
      "So I'll tell them you've been thinking about them a lot.",
    );

    expect(controlCalls).toHaveLength(1);
    expect(controlCalls[0]!.content).toBe(buildDisclosure('Sam'));
  });

  it('does not fire twice if two triggers land back to back', async () => {
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });
    await transcript('user', 'Hello?');
    await transcript('user', "Who's this?");

    expect(controlCalls).toHaveLength(1);
  });

  it('claims the disclosure exactly once under concurrency', async () => {
    // The real reason claimDisclosure is a conditional UPDATE rather than a
    // read-then-write: on Workers these handlers genuinely run concurrently.
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });

    await Promise.all([
      transcript('user', 'Hello?'),
      transcript('user', 'Hi?'),
      transcript('user', "Who's this?"),
    ]);

    expect(controlCalls).toHaveLength(1);
  });

  it('stays silent before arming — "hello" is ordinary mid-interview', async () => {
    // Populate the name explicitly. Without this the test passes for the wrong
    // reason: mid-interview `userFirstName` is unset, so forceDisclosure bails
    // on a *secondary* guard and the phase check is never exercised. Found by
    // mutation-testing the phase check — the test passed while the guard was
    // removed.
    await store.upsert(CALL_ID, { userFirstName: 'Sam' });

    await transcript('user', 'Hello?');
    await transcript('assistant', 'A'.repeat(300));

    expect(controlCalls).toHaveLength(0);
  });

  it('stays silent after the user backs out', async () => {
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });
    await toolCall('cancel_merge');
    expect((await store.get(CALL_ID))?.phase).toBe('interviewing');

    await transcript('user', 'Hello?');
    expect(controlCalls).toHaveLength(0);
  });
});

describe('arming refuses without a usable name', () => {
  it('tells the model to go get the name rather than arming', async () => {
    const response = await toolCall('arm_for_merge', { userFirstName: '' });
    const body = (await response.json()) as any;

    expect(body.results[0].result).toMatch(/don't have the user's/i);
    // Critically, it did NOT enter the window — a merge window we can't speak
    // into is worse than no merge window.
    expect((await store.get(CALL_ID))?.phase).toBe('interviewing');
  });
});

describe('handoff fails closed', () => {
  it('refuses and ends the call when intent extraction is unusable', async () => {
    await toolCall('arm_for_merge', { userFirstName: 'Sam' });

    const response = await handoff({ userFirstName: 'Sam' }); // missing the rest
    const body = (await response.json()) as any;

    expect(body.destination).toBeUndefined();
    expect(body.error).toMatch(/refusing handoff/i);

    // Never hand a recipient an assistant that doesn't know its boundaries.
    expect((await store.get(CALL_ID))?.phase).not.toBe('delegating');
    expect(controlCalls[0]?.content).toMatch(/something went wrong/i);
    expect(controlCalls[0]).toMatchObject({ endCallAfterSpoken: true });
  });
});

describe('hard blocks', () => {
  it('returns the refusal verbatim and marks the call blocked', async () => {
    const response = await toolCall('flag_blocked_situation', {
      category: 'domestic_violence',
      reasoning: 'User mentioned a restraining order.',
    });

    expect(((await response.json()) as any).results[0].result).toMatch(
      /800-799-7233/,
    );
    expect((await store.get(CALL_ID))?.phase).toBe('blocked');
  });
});

describe('webhook auth', () => {
  it('rejects a wrong secret', async () => {
    const response = await post({ type: 'status-update' }, 'wrong-secret');
    expect(response.status).toBe(401);
  });

  it('rejects a missing secret', async () => {
    const response = await app.request(
      '/vapi/webhook',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: { type: 'status-update' } }),
      },
      NO_ENV,
    );
    expect(response.status).toBe(401);
  });

  it('rejects a secret that is a prefix of the real one', async () => {
    const response = await post({ type: 'status-update' }, SECRET.slice(0, -1));
    expect(response.status).toBe(401);
  });
});

describe('session routes', () => {
  it('hands the app a number to display and never dials it', async () => {
    const response = await app.request('/session/start', {}, NO_ENV);
    const body = (await response.json()) as any;

    expect(body.phoneNumber).toBe('+15551234567');
    expect(body.instructions.merge).toMatch(/Merge Calls/);
  });

  it('returns 202 while post-call analysis is still running', async () => {
    await store.upsert(CALL_ID, { phase: 'ended' });
    const response = await app.request(
      `/session/${CALL_ID}/summary`,
      {},
      NO_ENV,
    );
    expect(response.status).toBe(202);
  });

  it('404s for an unknown call', async () => {
    const response = await app.request('/session/nope/status', {}, NO_ENV);
    expect(response.status).toBe(404);
  });
});

describe('recording', () => {
  it('is disabled on both assistants until consent is settled', async () => {
    const { interviewAssistant } = await import(
      '../src/assistants/interview.js'
    );
    const { delegateAssistant } = await import('../src/assistants/delegate.js');

    expect(
      interviewAssistant('https://x.test').artifactPlan.recordingEnabled,
    ).toBe(false);
    expect(
      delegateAssistant(intent, 'https://x.test').artifactPlan.recordingEnabled,
    ).toBe(false);
  });
});
