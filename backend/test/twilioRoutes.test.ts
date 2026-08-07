/**
 * routes/twilio.ts tests — Phase 2 skeleton scope. Verifies signature
 * enforcement, graceful "not configured" behaviour, per-call stream token
 * minting, and that a valid WebSocket-upgrade request actually reaches the
 * CallRelay Durable Object stub (faked here — the real DO's own behaviour is
 * exercised by e2e/twilio-relay.mjs against a live deploy, not by this file).
 */

import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Config } from '../src/lib/config.js';
import { MemoryStore } from '../src/lib/store.js';
import { computeTwilioSignature, signStreamToken } from '../src/lib/twilio.js';

const AUTH_TOKEN = 'test-auth-token';

const twilioConfig: Config = {
  twilio: {
    accountSid: 'ACtest',
    authToken: AUTH_TOKEN,
    phoneNumber: '+15551234567',
    serverUrl: 'https://example.test',
    voiceWebhookUrl: 'https://example.test/twilio/voice',
    statusWebhookUrl: 'https://example.test/twilio/status',
    streamUrlBase: 'wss://example.test/twilio/stream',
  },
  openai: { apiKey: 'sk-test' },
};

function makeApp(config: Config = twilioConfig) {
  return buildApp({ store: new MemoryStore(), config });
}

async function signedFormRequest(
  authToken: string,
  url: string,
  params: Record<string, string>,
) {
  const signature = await computeTwilioSignature(authToken, url, params);
  return {
    method: 'POST' as const,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  };
}

describe('GET /twilio/voice', () => {
  it('answers ok for dashboard/validator pings', async () => {
    const app = makeApp();
    const res = await app.request('/twilio/voice', {}, {} as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('POST /twilio/voice', () => {
  it('returns hangup TwiML, not a 500, when Twilio/OpenAI are not configured', async () => {
    const app = makeApp({});
    const res = await app.request(
      '/twilio/voice',
      { method: 'POST', body: 'CallSid=CA1' },
      {} as never,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<Hangup');
    expect(res.headers.get('content-type')).toMatch(/xml/);
  });

  it('rejects a request with a missing signature', async () => {
    const app = makeApp();
    const res = await app.request(
      '/twilio/voice',
      { method: 'POST', body: 'CallSid=CA1' },
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
  });

  it('rejects a request with a wrong signature', async () => {
    const app = makeApp();
    const res = await app.request(
      '/twilio/voice',
      {
        method: 'POST',
        headers: { 'x-twilio-signature': 'totally-bogus' },
        body: 'CallSid=CA1',
      },
      {} as never,
    );
    expect(await res.text()).toContain('<Reject');
  });

  it('rejects a validly-signed request replayed against the wrong URL (host/proxy mismatch)', async () => {
    const app = makeApp();
    const params = { CallSid: 'CA1' };
    const init = await signedFormRequest(AUTH_TOKEN, 'https://attacker.test/twilio/voice', params);
    const res = await app.request('/twilio/voice', init, {} as never);
    expect(await res.text()).toContain('<Reject');
  });

  it('returns Connect/Stream TwiML with a per-call token for a validly-signed request', async () => {
    const app = makeApp();
    const params = { CallSid: 'CA123', From: '+15550000000', To: '+15551234567' };
    const init = await signedFormRequest(AUTH_TOKEN, twilioConfig.twilio!.voiceWebhookUrl, params);

    const res = await app.request('/twilio/voice', init, {} as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<Connect>');
    expect(text).toMatch(/<Stream url="wss:\/\/example\.test\/twilio\/stream\/CA123\/[^"]+" \/>/);
  });

  it('rejects a request with no CallSid even if validly signed', async () => {
    const app = makeApp();
    const params = { From: '+15550000000' }; // no CallSid
    const init = await signedFormRequest(AUTH_TOKEN, twilioConfig.twilio!.voiceWebhookUrl, params);
    const res = await app.request('/twilio/voice', init, {} as never);
    expect(await res.text()).toContain('<Reject');
  });
});

describe('GET /twilio/stream/:callSid/:token', () => {
  it('answers 500 when Twilio is not configured', async () => {
    const app = makeApp({});
    const res = await app.request(
      '/twilio/stream/CA1/whatever',
      { headers: { upgrade: 'websocket' } },
      { CALL_RELAY: {} as never } as never,
    );
    expect(res.status).toBe(500);
  });

  it('401s with a bad token', async () => {
    const app = makeApp();
    const res = await app.request(
      '/twilio/stream/CA1/bogus-token',
      { headers: { upgrade: 'websocket' } },
      { CALL_RELAY: {} as never } as never,
    );
    expect(res.status).toBe(401);
  });

  it('401s with a token minted for a different call', async () => {
    const app = makeApp();
    const token = await signStreamToken(AUTH_TOKEN, 'CA999');
    const res = await app.request(
      `/twilio/stream/CA1/${token}`,
      { headers: { upgrade: 'websocket' } },
      { CALL_RELAY: {} as never } as never,
    );
    expect(res.status).toBe(401);
  });

  it('426s on a valid token but a non-websocket request', async () => {
    const app = makeApp();
    const token = await signStreamToken(AUTH_TOKEN, 'CA1');
    const res = await app.request(
      `/twilio/stream/CA1/${token}`,
      {},
      { CALL_RELAY: {} as never } as never,
    );
    expect(res.status).toBe(426);
  });

  it('routes a valid upgrade request to the CallRelay Durable Object stub, addressed by CallSid', async () => {
    // Real status-101 upgrade responses only exist under the actual Workers
    // runtime (Node's Response constructor rejects status 101 outright) —
    // the CallRelay DO's own upgrade behaviour is exercised live by
    // e2e/twilio-relay.mjs, not here. This test only checks that the route
    // resolves the right Durable Object instance and forwards the request.
    const app = makeApp();
    const token = await signStreamToken(AUTH_TOKEN, 'CA1');

    const seenRequests: Request[] = [];
    const idsRequested: string[] = [];
    const fakeStub = {
      fetch: async (req: Request) => {
        seenRequests.push(req);
        return new Response('forwarded', { status: 200, headers: { 'x-fake-relay': 'yes' } });
      },
    };
    const fakeNamespace = {
      idFromName: (name: string) => {
        idsRequested.push(name);
        return name;
      },
      get: () => fakeStub,
    };

    const res = await app.request(
      `/twilio/stream/CA1/${token}`,
      { headers: { upgrade: 'websocket' } },
      { CALL_RELAY: fakeNamespace as never } as never,
    );

    expect(res.headers.get('x-fake-relay')).toBe('yes');
    expect(seenRequests).toHaveLength(1);
    expect(idsRequested).toEqual(['CA1']);
  });
});

describe('POST /twilio/status', () => {
  it('answers 500 when Twilio is not configured', async () => {
    const app = makeApp({});
    const res = await app.request('/twilio/status', { method: 'POST', body: 'CallSid=CA1' }, {} as never);
    expect(res.status).toBe(500);
  });

  it('rejects a bad signature', async () => {
    const app = makeApp();
    const res = await app.request(
      '/twilio/status',
      { method: 'POST', headers: { 'x-twilio-signature': 'bogus' }, body: 'CallSid=CA1' },
      {} as never,
    );
    expect(res.status).toBe(401);
  });

  it('accepts a validly-signed request', async () => {
    const app = makeApp();
    const params = { CallSid: 'CA1', CallStatus: 'completed' };
    const init = await signedFormRequest(AUTH_TOKEN, twilioConfig.twilio!.statusWebhookUrl, params);
    const res = await app.request('/twilio/status', init, {} as never);
    expect(res.status).toBe(200);
  });
});
