/**
 * openaiRealtimeSocket.ts tests.
 *
 * The actual outbound WebSocket handshake (fetch + Upgrade header +
 * response.webSocket) can only be verified against a live OpenAI session —
 * confirmed once already, live, during Phase 0 of the Twilio migration. What
 * IS unit-testable without a network is everything this file controls once
 * it has *a* socket-like object: the session.created/session.updated
 * handshake sequencing, timeout behaviour, and error surfacing. A small fake
 * implementing just the WebSocket methods this file actually calls
 * (addEventListener/removeEventListener/send) stands in for the real thing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openOpenAiRealtimeSocket, updateSession } from '../src/lib/openaiRealtimeSocket.js';

class FakeSocket {
  listeners: Record<string, Array<(event: { type: string; data?: unknown }) => void>> = {};
  sent: string[] = [];
  accepted = false;

  addEventListener(type: string, cb: (event: { type: string; data?: unknown }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: (event: { type: string; data?: unknown }) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  accept() {
    this.accepted = true;
  }

  dispatch(type: string, data?: unknown) {
    for (const cb of [...(this.listeners[type] ?? [])]) cb({ type, data });
  }
}

// Lets internal `await fetch(...)` chains resolve before we dispatch a fake
// server event that the code hasn't started listening for yet.
async function flushMicrotasks(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('openOpenAiRealtimeSocket', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls .accept() and resolves once session.created arrives', async () => {
    const fake = new FakeSocket();
    vi.stubGlobal('fetch', async () => ({ webSocket: fake }));

    const promise = openOpenAiRealtimeSocket({ apiKey: 'sk-test' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'session.created' }));

    const ws = await promise;
    expect(ws).toBe(fake);
    expect(fake.accepted).toBe(true);
  });

  it('requests the model in the URL and sends the API key as a Bearer token', async () => {
    const fake = new FakeSocket();
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return { webSocket: fake };
    });

    const promise = openOpenAiRealtimeSocket({ apiKey: 'sk-test-123', model: 'my-model' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'session.created' }));
    await promise;

    expect(capturedUrl).toBe('https://api.openai.com/v1/realtime?model=my-model');
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test-123');
    expect(capturedHeaders.Upgrade).toBe('websocket');
  });

  it('throws with the status and a redacted body when the response has no webSocket', async () => {
    vi.stubGlobal('fetch', async () => ({
      webSocket: undefined,
      status: 401,
      text: async () => 'invalid key sk-test-123',
    }));

    await expect(
      openOpenAiRealtimeSocket({ apiKey: 'sk-test-123' }),
    ).rejects.toThrow(/401/);
    await expect(
      openOpenAiRealtimeSocket({ apiKey: 'sk-test-123' }),
    ).rejects.not.toThrow(/sk-test-123/);
  });

  it('rejects if the socket sends an error event before session.created', async () => {
    const fake = new FakeSocket();
    vi.stubGlobal('fetch', async () => ({ webSocket: fake }));

    const promise = openOpenAiRealtimeSocket({ apiKey: 'sk-test' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'error', error: { message: 'bad' } }));

    await expect(promise).rejects.toThrow(/error/i);
  });

  it('rejects if the socket closes before session.created', async () => {
    const fake = new FakeSocket();
    vi.stubGlobal('fetch', async () => ({ webSocket: fake }));

    const promise = openOpenAiRealtimeSocket({ apiKey: 'sk-test' });
    await flushMicrotasks();
    fake.dispatch('close');

    await expect(promise).rejects.toThrow(/closed/i);
  });

  it('ignores unrelated and unparseable events while waiting', async () => {
    const fake = new FakeSocket();
    vi.stubGlobal('fetch', async () => ({ webSocket: fake }));

    const promise = openOpenAiRealtimeSocket({ apiKey: 'sk-test' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'session.updated' })); // wrong type
    fake.dispatch('message', 'not json'); // unparseable
    fake.dispatch('message', JSON.stringify({ type: 'session.created' }));

    await expect(promise).resolves.toBe(fake);
  });
});

describe('updateSession', () => {
  it('sends a session.update event and resolves on session.updated', async () => {
    const fake = new FakeSocket();
    const promise = updateSession(fake as unknown as WebSocket, { foo: 'bar' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'session.updated' }));
    await promise;

    expect(fake.sent).toHaveLength(1);
    const sent = JSON.parse(fake.sent[0]!);
    expect(sent).toEqual({ type: 'session.update', session: { foo: 'bar' } });
  });

  it('rejects if OpenAI errors out the update', async () => {
    const fake = new FakeSocket();
    const promise = updateSession(fake as unknown as WebSocket, { foo: 'bar' });
    await flushMicrotasks();
    fake.dispatch('message', JSON.stringify({ type: 'error', error: { message: 'bad field' } }));

    await expect(promise).rejects.toThrow(/error/i);
  });
});
