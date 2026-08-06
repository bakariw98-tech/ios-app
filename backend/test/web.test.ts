/**
 * Static-content checks for GET /web. Not a substitute for the real
 * end-to-end check — see e2e/README.md for that. This just guards the
 * things that are cheap to catch here: the page implements the protocol it
 * claims to, and doesn't reintroduce the drift risk the correctionMarker
 * field on /realtime/session was added to close (see the doc comment on
 * that field in src/routes/realtime.ts).
 */

import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/lib/store.js';
import { NO_ENV, testConfig } from './helpers.js';

function getWebPage() {
  const app = buildApp({ store: new MemoryStore(), config: testConfig });
  return app.request('/web', {}, NO_ENV);
}

describe('GET /web', () => {
  it('serves HTML', async () => {
    const response = await getWebPage();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('implements the exact WebRTC protocol the iOS client uses', async () => {
    const body = await (await getWebPage()).text();
    // Data channel label is load-bearing — a typo here is a silent failure,
    // not an error, since OpenAI would just never send events on it.
    expect(body).toContain('oai-events');
    expect(body).toContain('response.cancel');
    expect(body).toContain('conversation.item.create');
    expect(body).toContain('response.create');
    // Same SDP-exchange endpoint the Swift client posts the offer to.
    expect(body).toContain('https://api.openai.com/v1/realtime/calls');
    // Same mint endpoint, called relatively so this works unchanged under
    // wrangler dev or the live deployment.
    expect(body).toContain('/realtime/session');
  });

  // The regression guard for the exact problem the correctionMarker field
  // was added to solve: if someone "simplifies" this page by hardcoding the
  // marker text instead of reading session.correctionMarker off the API
  // response, this test fails immediately instead of the marker silently
  // drifting out of sync with domain/inPersonBrief.ts's prompt.
  it('does not hardcode the correction marker', async () => {
    const body = await (await getWebPage()).text();
    expect(body).not.toContain('TYPED CORRECTION FROM');
    expect(body).not.toContain('NOT SPOKEN BY THE OTHER PERSON');
    expect(body).toContain('correctionMarker');
  });

  it('never embeds anything shaped like a real API key', async () => {
    const body = await (await getWebPage()).text();
    expect(body).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
    expect(body).not.toContain('OPENAI_API_KEY');
  });

  it('requests native echo cancellation', async () => {
    // This is the genuine testing advantage over iOS right now — browsers
    // generally handle this more reliably than AVAudioSession's
    // .voiceChatSpeaker dance. See ADR-005 and ios/README.md.
    const body = await (await getWebPage()).text();
    expect(body).toContain('echoCancellation');
  });

  it('exposes the documented test hooks for e2e/run.mjs', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('window.__pc');
    expect(body).toContain('window.__dc');
    expect(body).toContain('window.__sentLog');
    expect(body).toContain('window.__lastSent');
    expect(body).toContain('window.__correctionMarker');
    expect(body).toContain('data-state="idle"');
  });
});
