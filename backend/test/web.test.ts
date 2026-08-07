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
    // The typed intake step that now precedes it — see ADR-005's intake amendment.
    expect(body).toContain('/intake/turn');
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
    // Intake step's hooks — see the doc comment block at the top of the
    // inline script in src/routes/web.ts.
    expect(body).toContain('window.__intakeTurns');
    expect(body).toContain('window.__situationSoFar');
    expect(body).toContain('window.__startedWith');
  });

  // The intake step always runs, but must never become the landing state —
  // it only starts once the user has typed something and hit the button.
  // Also starts on the in-person tab, not the phone-call tab — see ADR-005's
  // phone-mode-in-web amendment.
  it('still starts in the idle state, on the in-person tab', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toMatch(/<body data-state="idle" data-mode="in-person">/);
  });

  // Guards the product decision at the cheapest possible layer: Skip is
  // always available, never gated behind a disabled attribute. See ADR-005's
  // intake amendment and the .btn-skip CSS comment in src/routes/web.ts.
  it('has an always-enabled Skip control for the intake step', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="skipButton"');
    expect(body).not.toMatch(/id="skipButton"[^>]*disabled/);
  });

  // A failing intake turn must stay visible without depending on
  // body[data-state="failed"] — see the .inline-error CSS comment, which
  // exists specifically because .error-banner is invisible outside that
  // state and would have silently hidden this exact error.
  it('shows intake errors independently of the failed state', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="intakeError"');
    expect(body).toContain('.inline-error');
  });
});

// Phone-call mode's only surface here: a number to look at and a tel: link
// to tap. See ADR-005's phone-mode-in-web amendment and routes/session.ts's
// own doc comment for why this is deliberately the entire surface — no live
// status, no transcript, no call-in-progress screen.
describe('GET /web — phone-call tab', () => {
  it('has both mode tabs, starting on in-person', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="tabInPerson"');
    expect(body).toContain('id="tabCall"');
  });

  it('fetches the phone number from GET /session/start, the existing endpoint', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain("fetch('/session/start')");
  });

  // The load-bearing compliance guard: nothing on this page may ever POST to
  // a session/call-placing path. routes/session.ts has no such endpoint to
  // POST to in the first place, but this catches the page-side half of that
  // guarantee directly, the same way the correction-marker test catches its
  // half — regardless of what routes exist, the client must never attempt this.
  it('never POSTs to any /session path — it only ever GETs the static number', async () => {
    const body = await (await getWebPage()).text();
    expect(body).not.toMatch(/fetch\(['"]\/session[^'"]*['"]\s*,\s*\{\s*method:\s*['"]POST['"]/);
  });

  it('renders the number as a tel: link, not a JS-driven dial action', async () => {
    const body = await (await getWebPage()).text();
    // A plain <a href="tel:..."> — the browser/OS handles the actual dial,
    // same as CallViewModel.dial in ios/DelegateApp/Views/CallView.swift
    // handing off to UIApplication.shared.open(tel://...). Nothing here is a
    // button wired to a fetch or an API call that places anything.
    expect(body).toContain('id="callButton"');
    expect(body).toMatch(/<a class="btn-call" id="callButton"/);
    expect(body).toContain('tel:');
  });

  it('surfaces the exact instructions text /session/start already returns', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="callInstructionBefore"');
    expect(body).toContain('id="callInstructionMerge"');
    expect(body).toContain('parsedBody.instructions');
  });

  it('exposes window.__sessionStart as a test hook', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('window.__sessionStart');
  });

  it('never embeds anything shaped like a real Vapi key or webhook secret', async () => {
    const body = await (await getWebPage()).text();
    expect(body).not.toContain('VAPI_API_KEY');
    expect(body).not.toContain('VAPI_WEBHOOK_SECRET');
  });
});

describe('GET /web — the conversation engine', () => {
  it('offers both engines and defaults to the conversation one', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="engineConversation"');
    expect(body).toContain('id="engineTransactional"');
    // The default matters: this is the engine under active development, and
    // shipping the page defaulted to the old relay path would mean nobody
    // exercises the new one by accident.
    expect(body).toMatch(
      /<button class="engine-button active" id="engineConversation">/,
    );
    expect(body).toMatch(/let\s+engine\s*=\s*'conversation'/);
  });

  it('routes each engine to its own endpoint pair', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain("'/conversation/turn'");
    expect(body).toContain("'/conversation/session'");
    expect(body).toContain("'/intake/turn'");
    expect(body).toContain("'/realtime/session'");
  });

  it('shows the extracted intent for review before going live', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('screen-review');
    expect(body).toContain('id="intentCard"');
    expect(body).toContain('id="goLiveButton"');
    // The goal and both kinds of limit have to be visible on that card —
    // reviewing an intent that hides what it will refuse is pointless.
    expect(body).toMatch(/Room\s+to\s+negotiate/i);
    expect(body).toMatch(/Will\s+never\s+agree\s+to/i);
    expect(body).toMatch(/Will\s+never\s+bring\s+up/i);
  });

  it('escapes intent text before putting it in the DOM', async () => {
    // The intent is model-generated from user-supplied text and rendered via
    // innerHTML, so it goes through an escaper. Without this the review card
    // is an injection sink fed by whatever the user typed.
    const body = await (await getWebPage()).text();
    expect(body).toMatch(/replace\(\/\[&<>\]\/g/);
  });

  it('never lets the conversation engine start a session without an intent', async () => {
    const body = await (await getWebPage()).text();
    // Skip is synchronous-and-local for the transactional engine, but the
    // conversation engine has nothing to go live with until extraction has
    // run — so its Skip goes through the server instead.
    expect(body).toMatch(/that's it, just go/);
    expect(body).toMatch(/engine === 'conversation'/);
  });

  it('exposes window.__engine and window.__intent as test hooks', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('window.__engine');
    expect(body).toContain('window.__intent');
  });
});

describe('GET /web — the spoken interview', () => {
  it('routes the conversation engine to the spoken interview, not the typed loop', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain("'/conversation/interview-session'");
    expect(body).toContain("'/conversation/extract'");
    expect(body).toMatch(/if\s*\(engine === 'conversation'\)\s*beginSpokenInterview\(\)/);
  });

  it('keeps a typed fallback for a denied microphone', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('id="typeInsteadButton"');
  });

  it('never gates the spoken flow on typed input', async () => {
    // Requiring a typed paragraph before you may start talking would put back
    // exactly the friction speaking removes.
    const body = await (await getWebPage()).text();
    expect(body).toMatch(/never gated on typed input/);
  });

  it('captures both sides of the interview transcript', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('response.output_audio_transcript.done');
    expect(body).toContain('input_audio_transcription');
  });

  it('watches for the finish tool by the name the server returned', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('response.function_call_arguments.done');
    expect(body).toMatch(/msg\.name === finishToolName/);
    expect(body).toMatch(/session\.finishToolName/);
  });

  it('latches the finish so the tool call and the button cannot both fire it', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toMatch(/if \(interviewFinished\) return;/);
    expect(body).toContain('id="interviewDoneButton"');
  });

  it('renders transcript bubbles as text, never as markup', async () => {
    // These carry speech-to-text output, which is not trusted markup.
    const body = await (await getWebPage()).text();
    expect(body).toMatch(/div\.textContent = text;/);
  });

  it('exposes window.__interviewTranscript as a test hook', async () => {
    const body = await (await getWebPage()).text();
    expect(body).toContain('window.__interviewTranscript');
  });
});
