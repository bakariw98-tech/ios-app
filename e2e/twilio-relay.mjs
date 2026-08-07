#!/usr/bin/env node
/**
 * Real end-to-end verification of the Twilio Media Streams relay
 * (CallRelay, Phase 2 of the Twilio migration — docs/technical-decisions.md
 * ADR-006).
 *
 * A fake Twilio Media Streams client using Node's built-in `WebSocket`
 * (stable since Node 22) — no browser, so none of run.mjs's
 * TLS-fingerprint/UDP sandbox problems apply here; this is plain WSS over
 * TCP, the same as any other outbound HTTPS-family connection this sandbox
 * already makes fine.
 *
 * What this proves: a correctly-signed `/twilio/voice` request gets back
 * TwiML pointing at a live stream URL, connecting to that URL reaches
 * CallRelay, and CallRelay's OpenAI Realtime bridge produces real audio
 * without needing a live human on the line to speak first (see
 * CallRelay.ts's `response.create` on connect).
 *
 * What this does NOT prove, and cannot: that a real PSTN call sounds
 * intelligible end to end, that Twilio's actual infrastructure frames audio
 * the same way this script's synthetic frames do, or that a real phone's
 * mixed audio triggers the same VAD/barge-in behavior. Phase 2's own
 * verification step (see the migration plan) is this script FIRST, then an
 * actual phone call — this script narrows down where a problem is, it
 * doesn't replace the phone call.
 *
 * Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN as env vars — the same
 * values that must already be set as secrets on the deployed Worker for
 * `/twilio/voice` to be configured at all. This script never places a real
 * phone call and never touches Twilio's API; it only needs the Auth Token
 * to compute the same request signature a real Twilio webhook would send.
 */

import { createHmac, randomBytes } from 'node:crypto';

const TARGET_URL =
  process.env.TARGET_URL ?? 'https://conversation-delegation.bakariw98.workers.dev';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

const AUDIO_WAIT_MS = Number(process.env.AUDIO_WAIT_MS ?? 8000);

const results = [];

function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  const icon = { PASS: '✓', FAIL: '✗', SKIP: '—' }[status];
  console.log(`[${icon}] ${id}: ${description}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Exact same algorithm as backend/src/lib/twilio.ts's computeTwilioSignature
 * — reimplemented here rather than imported, since this script has no build
 * step and lib/twilio.ts is TypeScript. Cross-checked against Twilio's own
 * published test vector in backend/test/twilio.test.ts; if this script's
 * signatures ever stop being accepted by a correctly-configured Worker,
 * check that test first before assuming this copy has drifted.
 */
function computeTwilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

async function main() {
  console.log(`Target: ${TARGET_URL}\n`);

  if (!ACCOUNT_SID || !AUTH_TOKEN) {
    record(
      'A',
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set',
      'SKIP',
      'set both to the same values configured as secrets on the Worker — see e2e/README.md',
    );
    return printSummaryAndExit();
  }
  record('A', 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set', 'PASS');

  const callSid = `CA${randomBytes(16).toString('hex')}`;
  const voiceUrl = `${TARGET_URL}/twilio/voice`;
  const params = {
    CallSid: callSid,
    AccountSid: ACCOUNT_SID,
    From: '+15550001111',
    To: '+15550002222',
    CallStatus: 'ringing',
  };
  const signature = computeTwilioSignature(AUTH_TOKEN, voiceUrl, params);

  let voiceResponseText;
  try {
    const response = await fetch(voiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: new URLSearchParams(params).toString(),
    });
    voiceResponseText = await response.text();
    record(
      'B',
      'POST /twilio/voice with a valid signature returns 200',
      response.status === 200 ? 'PASS' : 'FAIL',
      response.status === 200 ? undefined : `status ${response.status}`,
    );
  } catch (error) {
    record('B', 'POST /twilio/voice with a valid signature returns 200', 'FAIL', String(error));
    return printSummaryAndExit();
  }

  if (voiceResponseText.includes('<Reject')) {
    record(
      'C',
      'TwiML points at a live stream, not a signature rejection',
      'FAIL',
      'got <Reject> — the Worker\'s TWILIO_AUTH_TOKEN does not match the one this script was given',
    );
    return printSummaryAndExit();
  }
  if (voiceResponseText.includes('<Hangup')) {
    record(
      'C',
      'TwiML points at a live stream, not a signature rejection',
      'SKIP',
      'got <Hangup> — Twilio and/or OpenAI are not configured on the Worker yet',
    );
    return printSummaryAndExit();
  }

  const streamUrlMatch = voiceResponseText.match(/<Stream url="([^"]+)"/);
  if (!streamUrlMatch) {
    record(
      'C',
      'TwiML points at a live stream, not a signature rejection',
      'FAIL',
      `no <Stream url> found in response: ${voiceResponseText.slice(0, 300)}`,
    );
    return printSummaryAndExit();
  }
  const streamUrl = streamUrlMatch[1].replace(/&amp;/g, '&');
  record('C', 'TwiML points at a live stream, not a signature rejection', 'PASS', streamUrl);

  await runStreamCheckpoints(streamUrl, callSid);
  printSummaryAndExit();
}

function runStreamCheckpoints(streamUrl, callSid) {
  return new Promise((resolve) => {
    const ws = new WebSocket(streamUrl);
    const streamSid = `MZ${randomBytes(16).toString('hex')}`;
    let mediaEventsReceived = 0;
    let sawClearEvent = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(audioTimer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve();
    };

    ws.addEventListener('open', () => {
      record('D', 'WebSocket upgrade to the stream URL succeeds', 'PASS');

      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      ws.send(
        JSON.stringify({
          event: 'start',
          streamSid,
          start: { streamSid, callSid, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } },
        }),
      );
    });

    ws.addEventListener('message', (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data.toString());
      } catch {
        return;
      }
      if (parsed.event === 'media') mediaEventsReceived++;
      if (parsed.event === 'clear') sawClearEvent = true;
    });

    ws.addEventListener('error', (event) => {
      record('D', 'WebSocket upgrade to the stream URL succeeds', 'FAIL', String(event.message ?? event));
      finish();
    });

    const audioTimer = setTimeout(() => {
      record(
        'E',
        `CallRelay's OpenAI bridge produces audio within ${AUDIO_WAIT_MS}ms (no human speech needed — the assistant speaks first)`,
        mediaEventsReceived > 0 ? 'PASS' : 'FAIL',
        `${mediaEventsReceived} media event(s) received`,
      );

      ws.send(JSON.stringify({ event: 'stop', streamSid }));
      setTimeout(finish, 500);
    }, AUDIO_WAIT_MS);

    // sawClearEvent is informational only in this skeleton phase — this
    // script never sends real speech audio, so there's nothing for the
    // assistant's VAD to interrupt. Logged so a future phase (once this
    // script sends real speech) has a visible hook, not asserted on here.
    void sawClearEvent;
  });
}

function printSummaryAndExit() {
  console.log('\n--- Summary ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped (of ${results.length})`);

  if (fail > 0) {
    console.log(
      '\nA failure here means the socket plumbing itself is broken — worth ' +
        'fixing before ever picking up a real phone. A skip past checkpoint C ' +
        'means Twilio/OpenAI secrets are not set on the Worker yet, which is ' +
        'expected until that setup step is done; it is not a code problem.',
    );
  } else if (skip === 0) {
    console.log(
      '\nAll checkpoints passed. Next: an actual phone call to the Twilio ' +
        'number, per Phase 2\'s own verification step — this script cannot ' +
        'substitute for that.',
    );
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('\nUnexpected error running the e2e check:', error);
  process.exitCode = 1;
});
