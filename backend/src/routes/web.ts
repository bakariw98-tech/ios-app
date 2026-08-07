/**
 * A browser client for in-person mode, served at `GET /web`.
 *
 * Exists to verify the actual mechanism — mint a session, connect to OpenAI
 * over WebRTC, hear it talk, interrupt it without speaking — before ever
 * touching Xcode. Browser WebRTC is the *first-class* client path for
 * OpenAI's Realtime API (every browser ships it natively; iOS needs an added
 * third-party package because Apple doesn't), so this needs zero new runtime
 * dependencies and reuses `/realtime/session` exactly as the iOS client does.
 *
 * This implements the SAME protocol as
 * `ios/DelegateApp/Services/RealtimeSessionClient.swift` and
 * `ios/DelegateApp/Views/BriefView.swift` — same connection sequence, same
 * non-verbal Stop/correction mechanism, same states. It is not a redesign.
 * See docs/technical-decisions.md, ADR-005, for why the non-verbal
 * interrupt path is load-bearing rather than a nice-to-have: this mode's
 * users often cannot reliably interrupt by speaking, which is the entire
 * reason they're using it.
 *
 * Now exercises TWO endpoints, in sequence: `POST /intake/turn` (a short
 * typed back-and-forth that enriches the brief, see
 * domain/inPersonIntake.ts) followed by the unchanged `POST /realtime/session`.
 * The intake step always runs, but a prominent, never-disabled Skip control
 * ends it at any point and goes live immediately — the same friction-cost
 * reasoning as the Stop button below, applied to setup instead of mid-call.
 * See ADR-005's intake amendment in docs/technical-decisions.md.
 *
 * Also now has a second tab surfacing phone-call mode's `GET /session/start`
 * — a phone number plus a tap-to-dial `tel:` link, exactly mirroring
 * `ios/DelegateApp/Views/CallView.swift`. This is deliberately the ONLY
 * phone-mode surface added here: no live status, no transcript, no
 * call-in-progress screen. `routes/session.ts`'s own doc comment states
 * plainly why — "there is no endpoint that places a call... the human dials
 * it" (ADR-001's N4 compliance posture, docs/compliance.md) — and a browser
 * has no mechanism analogous to iOS's unbuilt CallKit-observation option to
 * even find out a call happened, let alone show it live. See
 * docs/technical-decisions.md's phone-mode-in-web amendment.
 *
 * Deliberately kept as an internal engineering tool, not a second product
 * surface: no auth (matches `/realtime/session`, which already has none —
 * this doesn't add a new privilege, it just makes an already-public,
 * already-billable endpoint reachable from a browser instead of only curl),
 * no styling polish beyond making Stop and Skip unmissable, no persistence,
 * no parsing of incoming `oai-events` beyond a visible debug line. See the
 * ADR-005 amendment this file's commit adds for the fuller reasoning.
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';

export function registerWebRoutes(app: Hono<AppBindings>): void {
  app.get('/web', (c) => c.html(WEB_CLIENT_HTML));
}

export const WEB_CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>In-person mode — test client</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, system-ui, sans-serif;
    max-width: 560px;
    margin: 0 auto;
    padding: 24px 20px 60px;
    line-height: 1.4;
  }
  h1 { font-size: 1.3rem; margin-bottom: 4px; }
  .subtitle { color: #888; font-size: 0.9rem; margin-bottom: 24px; }

  /* Top-level mode switch (in-person vs. phone-call), orthogonal to
     data-state below — data-state only ever governs which in-person screen
     shows, unchanged by this. Defaults to in-person so nothing about the
     existing flow's starting point changes. */
  .mode-panel { display: none; }
  body[data-mode="in-person"] .mode-in-person { display: block; }
  body[data-mode="call"] .mode-call { display: block; }
  .tab-row { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab-button {
    flex: 1; margin-top: 0; padding: 10px; font-size: 0.9rem; font-weight: 600;
    background: #e5e7eb; color: #555;
  }
  .tab-button.active { background: #111; color: white; }

  /* Every .screen is hidden by default; body[data-state] turns the matching
     one on. data-state is also the Playwright test hook — see e2e/run.mjs. */
  .screen { display: none; }
  body[data-state="idle"] .screen-brief,
  body[data-state="failed"] .screen-brief { display: block; }
  body[data-state="intake"] .screen-intake { display: block; }
  body[data-state="review"] .screen-review { display: block; }
  body[data-state="connecting"] .screen-connecting { display: block; }
  body[data-state="live"] .screen-live { display: block; }
  body[data-state="ended"] .screen-ended { display: block; }
  .error-banner { display: none; }
  body[data-state="failed"] .error-banner { display: block; }

  /* Phone number, made to look like a real tel: link a person taps — see
     .btn-call below, not the recessive default browser link styling. */
  .call-number {
    font-size: 1.6rem; font-weight: 700; text-align: center; margin: 20px 0 8px;
    letter-spacing: 0.02em;
  }
  .btn-call {
    display: block; text-decoration: none; text-align: center;
    background: #16a34a; color: white; font-weight: 700; font-size: 1.1rem;
    padding: 18px; border-radius: 10px; margin-top: 8px;
  }
  .call-instructions { margin-top: 20px; font-size: 0.9rem; }
  .call-instructions p { margin: 10px 0; }

  label { display: block; font-size: 0.85rem; font-weight: 600; margin: 16px 0 4px; }
  input[type="text"], textarea {
    width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px;
    border: 1px solid #999; border-radius: 8px;
  }
  textarea { min-height: 110px; resize: vertical; }

  button {
    font: inherit; border: none; border-radius: 10px; padding: 14px 18px;
    cursor: pointer; width: 100%; margin-top: 14px;
  }
  .btn-primary { background: #2563eb; color: white; font-weight: 600; font-size: 1rem; }
  .btn-primary:disabled { background: #93a3c1; cursor: not-allowed; }

  /* The single most important control on this page while live. Large,
     high-contrast, always tappable — not a secondary action. See the class
     doc comment above and ADR-005's amendment: this exists specifically
     because many of this mode's users cannot reliably interrupt by
     speaking, so a fast, zero-typing tap has to be the primary affordance. */
  .btn-stop {
    background: #ea580c; color: white; font-weight: 700; font-size: 1.15rem;
    padding: 20px 18px;
  }
  .btn-secondary { background: #e5e7eb; color: #111; }
  .btn-end { background: transparent; color: #b91c1c; border: 1px solid #b91c1c; font-size: 0.85rem; padding: 8px 14px; width: auto; }

  .correction-row { display: flex; gap: 8px; margin-top: 6px; }
  .correction-row input { flex: 1; }
  .correction-row button { width: auto; margin-top: 0; padding: 10px 16px; }

  /* The friction release valve for the intake step — same ethos as .btn-stop
     above (large, high-contrast, ALWAYS tappable, never disabled — see the
     script's skipButton handler) but a distinct colour so it's never
     confused with Stop, which means something different (interrupt a live
     session vs. skip setup entirely). See ADR-005's intake amendment. */
  .btn-skip {
    background: #0f766e; color: white; font-weight: 700; font-size: 1.05rem;
    padding: 16px 18px;
  }

  .intake-log { margin: 16px 0; display: flex; flex-direction: column; gap: 8px; }
  .intake-q, .intake-a {
    padding: 10px 12px; border-radius: 8px; font-size: 0.9rem; white-space: pre-wrap;
  }
  .intake-q { background: #e5e7eb; color: #111; align-self: flex-start; }
  .intake-a { background: #2563eb; color: white; align-self: flex-end; }

  /* Engine selector. The two engines answer different questions — one relays
     a prepared request to someone who wants to help you, the other negotiates
     a goal with someone who may not. Same UI shell, different endpoints. */
  .engine-row {
    display: flex; gap: 8px; margin: 4px 0 20px; border: 1px solid #333;
    border-radius: 8px; padding: 4px;
  }
  .engine-button {
    flex: 1; padding: 10px 8px; border: none; border-radius: 6px;
    background: transparent; color: #999; cursor: pointer; font-size: 0.85rem;
    text-align: center; line-height: 1.3;
  }
  .engine-button.active { background: #1f2937; color: white; }
  .engine-button small { display: block; font-size: 0.7rem; opacity: 0.7; margin-top: 2px; }

  /* The intent review card. Exists so the extracted goal and limits are
     visible BEFORE going live — this is the fastest way to see whether the
     interview actually drew the right things out, which is the part most
     likely to be wrong. */
  .intent-card {
    border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 16px 0;
    font-size: 0.85rem; line-height: 1.5;
  }
  .intent-card h3 {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: #888; margin: 14px 0 4px; font-weight: 600;
  }
  .intent-card h3:first-child { margin-top: 0; }
  .intent-card p { margin: 0; }
  .intent-card ul { margin: 0; padding-left: 18px; }
  .intent-card li { margin: 2px 0; }
  .intent-card .goal { font-size: 1rem; font-weight: 600; color: #fff; }
  .intent-card .limit { color: #f87171; }
  .intent-card .room { color: #4ade80; }
  .intent-card .muted { color: #777; font-style: italic; }
  .intake-row { display: flex; gap: 8px; margin-top: 6px; }
  .intake-row input { flex: 1; }
  .intake-row button { width: auto; margin-top: 0; padding: 10px 16px; }

  .error-banner {
    background: #fee2e2; color: #991b1b; border-radius: 8px; padding: 12px 14px;
    margin-top: 16px; font-size: 0.9rem; white-space: pre-wrap;
  }

  /* Deliberately separate from .error-banner, which is display:none unless
     body[data-state="failed"] — an intake error must stay visible while
     data-state is still "intake" (a failed intake turn does NOT transition
     to the failed state, since Skip must keep working). Reusing
     .error-banner here would make the error silently invisible. */
  .inline-error {
    background: #fee2e2; color: #991b1b; border-radius: 8px; padding: 10px 12px;
    margin-top: 10px; font-size: 0.85rem; white-space: pre-wrap;
  }
  .inline-error[hidden] { display: none; }
  .status-line { font-size: 0.8rem; color: #888; margin-top: 10px; }
  .live-badge {
    display: inline-flex; align-items: center; gap: 8px; font-weight: 600;
    margin-bottom: 6px;
  }
  .live-dot {
    width: 10px; height: 10px; border-radius: 50%; background: #16a34a;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  #debugLog {
    margin-top: 24px; font-size: 0.75rem; color: #999; max-height: 140px;
    overflow-y: auto; border-top: 1px solid #333; padding-top: 8px;
    white-space: pre-wrap; word-break: break-all;
  }
</style>
</head>
<body data-state="idle" data-mode="in-person">
  <div class="tab-row">
    <button class="tab-button active" id="tabInPerson">In-person</button>
    <button class="tab-button" id="tabCall">Phone call</button>
  </div>

  <div class="mode-panel mode-in-person">
  <h1>In-person mode</h1>
  <p class="subtitle">
    Internal test client — verifies the same WebRTC + correction protocol as
    the iOS app, without needing Xcode. Not a product surface.
  </p>

  <div class="screen screen-brief">
    <div class="engine-row">
      <button class="engine-button" id="engineTransactional">
        Transactional
        <small>relay a request</small>
      </button>
      <button class="engine-button active" id="engineConversation">
        Hard conversation
        <small>negotiate a goal</small>
      </button>
    </div>

    <label for="nameInput">Your name (optional)</label>
    <input type="text" id="nameInput" placeholder="Sam">

    <label for="situationInput" id="situationLabel">What do you need to talk to them about?</label>
    <textarea id="situationInput" maxlength="4000"
      placeholder="e.g. &quot;I need to talk to my friend Alex. We haven&#39;t spoken since March and I want to fix it.&quot;"></textarea>

    <button class="btn-primary" id="startButton" disabled>Next — a few quick questions</button>

    <div class="error-banner" id="errorBanner"></div>
  </div>

  <div class="screen screen-review">
    <p class="subtitle">
      Here&rsquo;s what it understood. Check the goal and the limits before you
      start &mdash; this is what it will actually be working from.
    </p>

    <div class="intent-card" id="intentCard"></div>

    <button class="btn-primary" id="goLiveButton">Start talking</button>
    <button class="btn-skip" id="reviewBackButton">Back</button>
  </div>

  <div class="screen screen-intake">
    <p class="subtitle">
      A couple of quick questions so the AI has enough to work with. Type
      your answer, or skip straight to live at any point &mdash; no penalty
      either way.
    </p>

    <div id="intakeLog" class="intake-log"></div>

    <label for="intakeInput">Your answer</label>
    <div class="intake-row">
      <input type="text" id="intakeInput" placeholder="Type your answer…">
      <button class="btn-secondary" id="intakeSendButton">Send</button>
    </div>

    <button class="btn-skip" id="skipButton">Skip — start talking now</button>

    <div class="status-line" id="intakeStatus"></div>
    <div class="inline-error" id="intakeError" hidden></div>
  </div>

  <div class="screen screen-connecting">
    <p>Connecting…</p>
  </div>

  <div class="screen screen-live">
    <div class="live-badge"><span class="live-dot"></span> Live</div>
    <p class="subtitle">
      Hold the phone toward the conversation. I&#39;ll handle the back-and-forth.
    </p>

    <button class="btn-stop" id="stopButton">✋ Wait — stop</button>

    <label for="correctionInput" style="margin-top:20px;">Say something specific</label>
    <div class="correction-row">
      <input type="text" id="correctionInput" placeholder="Type a correction…">
      <button class="btn-secondary" id="correctionButton">Send</button>
    </div>

    <button class="btn-end" id="endButton" style="margin-top:24px;">End</button>

    <div class="status-line" id="statusLine"></div>
    <audio id="remoteAudio" autoplay></audio>
  </div>

  <div class="screen screen-ended">
    <p>Done.</p>
    <button class="btn-primary" id="resetButton">Say something else</button>
  </div>

  <div id="debugLog"></div>
  </div>

  <div class="mode-panel mode-call">
    <h1>Phone-call mode</h1>
    <p class="subtitle">
      Paused, not removed — see ADR-005. This tab only ever shows a number to
      dial; nothing here places a call. See
      <code>routes/session.ts</code>'s own doc comment and ADR-001's N4
      compliance posture in <code>docs/technical-decisions.md</code>.
    </p>

    <div id="callLoading">Loading…</div>
    <div class="inline-error" id="callError" hidden></div>

    <div id="callLoaded" hidden>
      <div class="call-number" id="callNumber"></div>
      <a class="btn-call" id="callButton" href="#">Call</a>

      <div class="call-instructions">
        <p id="callInstructionBefore"></p>
        <p id="callInstructionMerge"></p>
      </div>
    </div>
  </div>

<script type="module">
  // ---------------------------------------------------------------------
  // Test hooks. Deliberately present from the start, not bolted on later —
  // e2e/run.mjs reads these directly via page.evaluate(). See
  // docs/technical-decisions.md, ADR-005.
  //   window.__pc              the RTCPeerConnection, once created
  //   window.__dc              the "oai-events" data channel, once created
  //   window.__sentLog         array of every payload sent over the data channel, in order
  //   window.__lastSent        sentLog[sentLog.length - 1], for convenience
  //   window.__lastReceived    most recent parsed message received over the data channel
  //   window.__correctionMarker  { prefix, suffix } as returned by /realtime/session
  //   window.__intakeTurns     the running intake transcript, the same array POSTed to /intake/turn
  //   window.__situationSoFar  the exact string Skip would send right now
  //   window.__lastIntakeReply the last parsed /intake/turn response body
  //   window.__startedWith     the exact brief object POSTed to /realtime/session — lets a
  //                            checker confirm the enriched paragraph reached it unchanged
  //   window.__sessionStart    the parsed GET /session/start response, once the Phone call
  //                            tab has been opened — { phoneNumber, instructions }
  //   window.__engine          'conversation' | 'transactional' — which engine is selected
  //   window.__intent          the extracted ConversationIntent, once the interview finishes
  //                            (conversation engine only; null for the transactional one)
  // ---------------------------------------------------------------------
  window.__sentLog = [];
  window.__intakeTurns = [];
  window.__situationSoFar = '';

  const body = document.body;
  const $ = (id) => document.getElementById(id);

  const tabInPerson = $('tabInPerson');
  const tabCall = $('tabCall');
  const callLoading = $('callLoading');
  const callError = $('callError');
  const callLoaded = $('callLoaded');
  const callNumber = $('callNumber');
  const callButton = $('callButton');
  const callInstructionBefore = $('callInstructionBefore');
  const callInstructionMerge = $('callInstructionMerge');

  const engineTransactional = $('engineTransactional');
  const engineConversation = $('engineConversation');
  const situationLabel = $('situationLabel');
  const intentCard = $('intentCard');
  const goLiveButton = $('goLiveButton');
  const reviewBackButton = $('reviewBackButton');

  const situationInput = $('situationInput');
  const nameInput = $('nameInput');
  const startButton = $('startButton');
  const errorBanner = $('errorBanner');
  const intakeLog = $('intakeLog');
  const intakeInput = $('intakeInput');
  const intakeSendButton = $('intakeSendButton');
  const skipButton = $('skipButton');
  const intakeStatus = $('intakeStatus');
  const intakeError = $('intakeError');
  const stopButton = $('stopButton');
  const correctionInput = $('correctionInput');
  const correctionButton = $('correctionButton');
  const endButton = $('endButton');
  const resetButton = $('resetButton');
  const statusLine = $('statusLine');
  const remoteAudio = $('remoteAudio');
  const debugLog = $('debugLog');

  function setState(state, errorMessage) {
    body.dataset.state = state;
    errorBanner.textContent = errorMessage || '';
  }

  function log(line) {
    const time = new Date().toISOString().slice(11, 19);
    debugLog.textContent = \`[\${time}] \${line}\\n\` + debugLog.textContent;
  }

  // --- Engine selector -------------------------------------------------
  //
  // 'conversation' is the default: it's the engine under active development
  // and the one worth exercising. 'transactional' keeps the original
  // relay-a-brief path reachable so a regression in it is still visible.

  let engine = 'conversation';

  const ENGINE_COPY = {
    conversation: {
      label: 'What do you need to talk to them about?',
      placeholder:
        "e.g. \\"I need to talk to my friend Alex. We haven't spoken since March and I want to fix it.\\"",
      next: 'Next — a few quick questions',
    },
    transactional: {
      label: 'What do you need said?',
      placeholder:
        "e.g. \\"I'm at McDonald's, I want a McDouble no pickles and a water.\\"",
      next: 'Next — a couple of quick questions',
    },
  };

  engineTransactional.addEventListener('click', () => setEngine('transactional'));
  engineConversation.addEventListener('click', () => setEngine('conversation'));

  function setEngine(next) {
    engine = next;
    window.__engine = engine;
    engineConversation.classList.toggle('active', next === 'conversation');
    engineTransactional.classList.toggle('active', next === 'transactional');
    const copy = ENGINE_COPY[next];
    situationLabel.textContent = copy.label;
    situationInput.placeholder = copy.placeholder;
    startButton.textContent = copy.next;
  }

  // Called on load so window.__engine and the copy are correct from the start,
  // not only after the first click. Idempotent — the markup already ships in
  // the conversation-engine state.
  setEngine('conversation');

  /** The endpoint pair for the selected engine — the only real difference between them. */
  function endpoints() {
    return engine === 'conversation'
      ? { turn: '/conversation/turn', session: '/conversation/session' }
      : { turn: '/intake/turn', session: '/realtime/session' };
  }

  // --- Mode tabs (in-person vs. phone-call) ---------------------------

  tabInPerson.addEventListener('click', () => setMode('in-person'));
  tabCall.addEventListener('click', () => setMode('call'));

  function setMode(mode) {
    body.dataset.mode = mode;
    tabInPerson.classList.toggle('active', mode === 'in-person');
    tabCall.classList.toggle('active', mode === 'call');
    if (mode === 'call') loadCallScreen();
  }

  let callScreenLoaded = false;

  // Fetched once per page load, lazily, the first time the tab is opened —
  // GET /session/start returns a static phone number, never anything
  // call-specific, so there is nothing to refresh on repeat visits.
  async function loadCallScreen() {
    if (callScreenLoaded) return;
    callScreenLoaded = true;

    try {
      const res = await fetch('/session/start');
      const parsedBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          \`/session/start \${res.status}: \${parsedBody.error || 'unknown error'}\`,
        );
      }
      window.__sessionStart = parsedBody;

      callNumber.textContent = formatPhoneNumber(parsedBody.phoneNumber);
      // tel: wants raw digits (plus a leading +), not the display format —
      // same construction as CallViewModel.dial in
      // ios/DelegateApp/Views/CallView.swift. This is a plain anchor tag:
      // tapping it hands off to the OS's own dialler, exactly as if the
      // number had been typed by hand. Nothing on this page places a call.
      callButton.href = \`tel:\${parsedBody.phoneNumber.replace(/[^\\d+]/g, '')}\`;
      callInstructionBefore.textContent = parsedBody.instructions?.before ?? '';
      callInstructionMerge.textContent = parsedBody.instructions?.merge ?? '';

      callLoading.hidden = true;
      callLoaded.hidden = false;
    } catch (error) {
      callScreenLoaded = false; // allow retry by switching tabs again
      callLoading.hidden = true;
      callError.hidden = false;
      callError.textContent = String(error && error.message ? error.message : error);
    }
  }

  // Cosmetic only — display format, never what's sent as the tel: target.
  // Falls back to the raw string for anything that isn't an 11-digit +1
  // number, rather than mangling an unexpected format.
  function formatPhoneNumber(raw) {
    const digits = (raw || '').replace(/\\D/g, '');
    if (digits.length === 11 && digits[0] === '1') {
      return \`(\${digits.slice(1, 4)}) \${digits.slice(4, 7)}-\${digits.slice(7)}\`;
    }
    if (digits.length === 10) {
      return \`(\${digits.slice(0, 3)}) \${digits.slice(3, 6)}-\${digits.slice(6)}\`;
    }
    return raw;
  }

  situationInput.addEventListener('input', () => {
    startButton.disabled = situationInput.value.trim().length === 0;
  });

  startButton.addEventListener('click', () => {
    beginIntake();
  });

  intakeSendButton.addEventListener('click', sendIntakeAnswer);
  intakeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendIntakeAnswer();
  });

  // The friction release valve. Never disabled, not even mid-request — see
  // the .btn-skip CSS comment. Purely client-side and synchronous: no
  // network call, so Skip works even if /intake/turn or OpenAI itself is
  // down. intakeAbandoned makes any in-flight /intake/turn response a no-op
  // once Skip has already moved on, so a late reply can't yank the user back
  // into the intake screen after they've chosen to leave it.
  skipButton.addEventListener('click', () => {
    if (engine === 'conversation') {
      // The conversation engine has nothing to go live WITH until the intent
      // has been extracted — the interview is the product here, not a warm-up
      // to it. So Skip can't be the synchronous local bail-out it is for the
      // transactional engine; instead it says "just go" in the user's own
      // voice, which the interview prompt already treats as a hard stop, and
      // lets the server extract from whatever it has. One round trip, but it
      // cannot produce a session with no goal in it.
      intakeTurns.push({ role: 'user', text: "that's it, just go" });
      window.__intakeTurns = intakeTurns;
      appendIntakeBubble('intake-a', "that's it, just go");
      postIntakeTurn(situationInput.value.trim());
      return;
    }
    intakeAbandoned = true;
    goLive(window.__situationSoFar || situationInput.value.trim());
  });

  goLiveButton.addEventListener('click', () => goLive());

  reviewBackButton.addEventListener('click', () => setState('intake'));

  stopButton.addEventListener('click', () => {
    // The primary interrupt path. One tap, no typing. See the .btn-stop
    // comment in <style> and ADR-005's amendment for why this has to be
    // this simple.
    send({ type: 'response.cancel' });
  });

  correctionButton.addEventListener('click', sendCorrection);
  correctionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCorrection();
  });

  endButton.addEventListener('click', () => {
    teardown();
    setState('ended');
  });

  resetButton.addEventListener('click', () => {
    situationInput.value = '';
    nameInput.value = '';
    correctionInput.value = '';
    intakeInput.value = '';
    intakeLog.innerHTML = '';
    intakeError.hidden = true;
    intakeStatus.textContent = '';
    intakeTurns = [];
    window.__intakeTurns = intakeTurns;
    window.__situationSoFar = '';
    currentIntent = null;
    window.__intent = null;
    intentCard.innerHTML = '';
    intakeAbandoned = false;
    startButton.disabled = true;
    setState('idle');
  });

  let pc = null;
  let dc = null;
  let intakeTurns = [];
  /** The extracted ConversationIntent, held between the review screen and going live. */
  let currentIntent = null;
  // Set true the instant Skip is clicked, so a late-arriving /intake/turn
  // response (the user skipped while a request was in flight) is a no-op
  // rather than something that could still move the UI.
  let intakeAbandoned = false;

  function beginIntake() {
    const situation = situationInput.value.trim();
    intakeTurns = [];
    window.__intakeTurns = intakeTurns;
    window.__situationSoFar = situation;
    intakeAbandoned = false;
    intakeLog.innerHTML = '';
    intakeError.hidden = true;
    setState('intake');

    // Shown for context, not stored in intakeTurns — the original situation
    // already travels separately as the request's situation field (see
    // IntakeRequestSchema), so adding it here too would double it up there.
    appendIntakeBubble('intake-a', situation);

    postIntakeTurn(situation);
  }

  // Appends one bubble; deliberately never clears/rebuilds the whole log
  // (a full re-render from intakeTurns would erase the seed bubble in
  // beginIntake, which isn't stored in intakeTurns — see its comment).
  function appendIntakeBubble(className, text) {
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    intakeLog.appendChild(div);
  }

  function sendIntakeAnswer() {
    const text = intakeInput.value.trim();
    if (!text) return;
    intakeTurns.push({ role: 'user', text });
    window.__intakeTurns = intakeTurns;
    appendIntakeBubble('intake-a', text);
    intakeInput.value = '';
    postIntakeTurn(situationInput.value.trim());
  }

  async function postIntakeTurn(situation) {
    intakeSendButton.disabled = true;
    intakeStatus.textContent = 'Thinking…';
    intakeError.hidden = true;

    const turnUrl = endpoints().turn;

    let reply;
    try {
      const res = await fetch(turnUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          situation,
          userFirstName: nameInput.value.trim() || undefined,
          turns: intakeTurns,
        }),
      });
      const parsedBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(\`\${turnUrl} \${res.status}: \${parsedBody.error || 'unknown error'}\${parsedBody.detail ? \` — \${parsedBody.detail}\` : ''}\`);
      }
      reply = parsedBody;
    } catch (error) {
      if (intakeAbandoned) return; // Skip already moved on — don't fight it.
      log(\`intake turn failed: \${error}\`);
      // Deliberately does NOT setState('failed') — a failing intake must
      // never block going live. Stay on the intake screen; Skip keeps
      // working (it's synchronous and needs nothing from this request).
      intakeError.hidden = false;
      intakeError.textContent = String(error && error.message ? error.message : error);
      intakeSendButton.disabled = false;
      intakeStatus.textContent = '';
      return;
    }

    if (intakeAbandoned) return;

    window.__lastIntakeReply = reply;
    window.__situationSoFar = reply.situationSoFar || window.__situationSoFar;
    intakeSendButton.disabled = false;
    intakeStatus.textContent = '';

    if (reply.done) {
      // The two engines finish differently: the transactional one returns a
      // paragraph and goes straight live, the conversation one returns a
      // structured intent that gets shown for review first. Seeing the goal
      // and the limits before going live is the fastest way to catch an
      // interview that drew out the wrong thing.
      if (engine === 'conversation') {
        currentIntent = reply.intent;
        window.__intent = currentIntent;
        renderIntentCard(currentIntent);
        setState('review');
      } else {
        goLive(reply.situation);
      }
      return;
    }

    intakeTurns.push({ role: 'assistant', text: reply.question });
    window.__intakeTurns = intakeTurns;
    appendIntakeBubble('intake-q', reply.question);
  }

  function renderIntentCard(intent) {
    const esc = (s) =>
      String(s ?? '').replace(/[&<>]/g, (ch) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch],
      );
    const list = (items, className) =>
      items && items.length
        ? \`<ul class="\${className}">\${items.map((i) => \`<li>\${esc(i)}</li>\`).join('')}</ul>\`
        : '<p class="muted">none</p>';

    intentCard.innerHTML = [
      '<h3>Goal</h3>',
      \`<p class="goal">\${esc(intent.goal)}</p>\`,
      '<h3>Speaking to</h3>',
      \`<p>\${esc(intent.recipientName)} — \${esc(intent.relationship.replace(/_/g, ' '))}, \${esc(intent.tone)} tone</p>\`,
      '<h3>Background it will work from</h3>',
      \`<p>\${esc(intent.context)}</p>\`,
      '<h3>Room to negotiate — it can offer these on its own</h3>',
      list(intent.acceptableCompromises, 'room'),
      '<h3>Will never agree to</h3>',
      list(intent.hardLimits, 'limit'),
      '<h3>Will never bring up</h3>',
      list(intent.neverSay, 'limit'),
      '<h3>Must get said</h3>',
      list(intent.mustSay, ''),
      '<h3>Wants to find out</h3>',
      list(intent.questionsToAnswer, ''),
    ].join('');
  }

  function goLive(situation) {
    // The conversation engine sends the reviewed intent; the transactional one
    // sends the enriched paragraph, unchanged from what it always sent.
    const payload =
      engine === 'conversation'
        ? { intent: currentIntent }
        : { situation, userFirstName: nameInput.value.trim() || undefined };

    start(payload).catch((error) => {
      console.error(error);
      setState('failed', String(error && error.message ? error.message : error));
    });
  }

  async function start(brief) {
    window.__startedWith = brief;
    const sessionUrl = endpoints().session;
    setState('connecting');
    log(\`POSTing to \${sessionUrl}…\`);

    const res = await fetch(sessionUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(brief),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        \`\${sessionUrl} \${res.status}: \${body.error || 'unknown error'}\`
      );
    }

    const session = await res.json();
    window.__correctionMarker = session.correctionMarker;
    log(\`Session minted. voice=\${session.voice} model=\${session.model}\`);

    // No ICE servers: OpenAI's endpoint is a direct SDP exchange over HTTPS,
    // not a peer needing NAT traversal to a third party — same reasoning as
    // RealtimeSessionClient.swift's \`connect(using:)\`.
    pc = new RTCPeerConnection({ iceServers: [] });
    window.__pc = pc;

    pc.oniceconnectionstatechange = () => {
      statusLine.textContent = \`ICE: \${pc.iceConnectionState}\`;
      log(\`ICE connection state: \${pc.iceConnectionState}\`);
    };
    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      log('Remote audio track attached.');
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    // Created BEFORE createOffer() so it's included in the SDP — same
    // requirement documented in RealtimeSessionClient.swift's \`connect\`.
    dc = pc.createDataChannel('oai-events');
    window.__dc = dc;
    dc.onopen = () => log('Data channel open.');
    dc.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = event.data;
      }
      window.__lastReceived = parsed;
      log(\`recv: \${event.data.slice(0, 200)}\`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    log('POSTing SDP offer to OpenAI…');
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${session.clientSecret}\`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });

    if (!sdpResponse.ok) {
      throw new Error(\`SDP exchange failed: \${sdpResponse.status}\`);
    }

    const answerSDP = await sdpResponse.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSDP });
    log('Remote description set. signalingState=' + pc.signalingState);

    setState('live');
  }

  function sendCorrection() {
    const text = correctionInput.value.trim();
    if (!text) return;

    const marker = window.__correctionMarker;
    const name = nameInput.value.trim();
    const label = name || "the person you're speaking for";
    // Exact format the model is taught to recognise in
    // domain/inPersonBrief.ts's buildInPersonInstructions — sourced from the
    // API response, never hardcoded here, so this file cannot drift out of
    // sync with the prompt the way a literal copy could.
    const marked = \`[\${marker.prefix} \${label} — \${marker.suffix}]: \${text}\`;

    send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: marked }],
      },
    });
    send({ type: 'response.create' });

    correctionInput.value = '';
  }

  function send(payload) {
    if (!dc || dc.readyState !== 'open') {
      log(\`(not sent — data channel not open) \${JSON.stringify(payload)}\`);
      return;
    }
    dc.send(JSON.stringify(payload));
    window.__sentLog.push(payload);
    window.__lastSent = payload;
    log(\`sent: \${JSON.stringify(payload)}\`);
  }

  function teardown() {
    if (dc) { try { dc.close(); } catch {} }
    if (pc) { try { pc.close(); } catch {} }
    dc = null;
    pc = null;
    window.__dc = null;
    window.__pc = null;
    if (remoteAudio.srcObject) {
      remoteAudio.srcObject.getTracks().forEach((t) => t.stop());
      remoteAudio.srcObject = null;
    }
  }
</script>
</body>
</html>
`;
