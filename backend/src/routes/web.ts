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
 * Deliberately kept as an internal engineering tool, not a second product
 * surface: no auth (matches `/realtime/session`, which already has none —
 * this doesn't add a new privilege, it just makes an already-public,
 * already-billable endpoint reachable from a browser instead of only curl),
 * no styling polish beyond making Stop unmissable, no persistence, no
 * parsing of incoming `oai-events` beyond a visible debug line. See the
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

  /* Every .screen is hidden by default; body[data-state] turns the matching
     one on. data-state is also the Playwright test hook — see e2e/run.mjs. */
  .screen { display: none; }
  body[data-state="idle"] .screen-brief,
  body[data-state="failed"] .screen-brief { display: block; }
  body[data-state="connecting"] .screen-connecting { display: block; }
  body[data-state="live"] .screen-live { display: block; }
  body[data-state="ended"] .screen-ended { display: block; }
  .error-banner { display: none; }
  body[data-state="failed"] .error-banner { display: block; }

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

  .error-banner {
    background: #fee2e2; color: #991b1b; border-radius: 8px; padding: 12px 14px;
    margin-top: 16px; font-size: 0.9rem; white-space: pre-wrap;
  }
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
<body data-state="idle">
  <h1>In-person mode</h1>
  <p class="subtitle">
    Internal test client — verifies the same WebRTC + correction protocol as
    the iOS app, without needing Xcode. Not a product surface.
  </p>

  <div class="screen screen-brief">
    <label for="nameInput">Your name (optional)</label>
    <input type="text" id="nameInput" placeholder="Sam">

    <label for="situationInput">What do you need said?</label>
    <textarea id="situationInput" maxlength="4000"
      placeholder='e.g. "I&#39;m at McDonald&#39;s, I want a McDouble no pickles and a water."'></textarea>

    <button class="btn-primary" id="startButton" disabled>Start Talking</button>

    <div class="error-banner" id="errorBanner"></div>
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
  // ---------------------------------------------------------------------
  window.__sentLog = [];

  const body = document.body;
  const $ = (id) => document.getElementById(id);

  const situationInput = $('situationInput');
  const nameInput = $('nameInput');
  const startButton = $('startButton');
  const errorBanner = $('errorBanner');
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

  situationInput.addEventListener('input', () => {
    startButton.disabled = situationInput.value.trim().length === 0;
  });

  startButton.addEventListener('click', () => {
    start({
      situation: situationInput.value.trim(),
      userFirstName: nameInput.value.trim() || undefined,
    }).catch((error) => {
      console.error(error);
      setState('failed', String(error && error.message ? error.message : error));
    });
  });

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
    startButton.disabled = true;
    setState('idle');
  });

  let pc = null;
  let dc = null;

  async function start(brief) {
    setState('connecting');
    log('POSTing brief to /realtime/session…');

    const res = await fetch('/realtime/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(brief),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        \`/realtime/session \${res.status}: \${body.error || 'unknown error'}\`
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
