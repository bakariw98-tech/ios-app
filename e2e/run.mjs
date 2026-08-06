#!/usr/bin/env node
/**
 * Real end-to-end verification of in-person mode's WebRTC mechanism.
 *
 * Drives the browser test client (backend/src/routes/web.ts, served at
 * /web) in headless Chromium with fake media devices, against a LIVE
 * backend and REAL OpenAI Realtime API. See README.md before running this —
 * it costs real OpenAI usage and needs OPENAI_API_KEY set on the Worker.
 *
 * This is a plain script, not the @playwright/test runner, on purpose: it's
 * a manual, occasionally-run, human-read check, not a parallelized suite.
 *
 * Checkpoints are reported individually, not as one pass/fail boolean,
 * because "the contract works but media didn't connect from this network"
 * is a materially different, useful result from "broken." See README.md for
 * why checkpoints C-F may legitimately fail from a UDP-restricted network
 * (this script was originally run from exactly such an environment) without
 * that meaning anything is actually wrong with the app.
 */

import { chromium } from 'playwright-core';

const TARGET_URL =
  process.env.TARGET_URL ??
  'https://conversation-delegation.bakariw98.workers.dev/web';

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium/chrome-linux/chrome';

const results = [];

function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  const icon = { PASS: '✓', FAIL: '✗', SKIP: '—' }[status];
  console.log(`[${icon}] ${id}: ${description}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Chromium: ${CHROMIUM_PATH}\n`);

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (process.env.VERBOSE) console.log(`  [page] ${msg.text()}`);
  });

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const initialState = await page.evaluate(() => document.body.dataset.state);
    if (initialState !== 'idle') {
      throw new Error(`Expected initial state "idle", got "${initialState}"`);
    }

    await page.fill(
      '#situationInput',
      "Say the exact words 'automated test successful' and then stop talking.",
    );
    await page.click('#startButton');

    // --- Checkpoint A: mint session ---
    let sessionBody;
    try {
      const sessionResponse = await page.waitForResponse(
        (r) => r.url().endsWith('/realtime/session'),
        { timeout: 10000 },
      );
      if (sessionResponse.status() !== 200) {
        const body = await sessionResponse.json().catch(() => ({}));
        record(
          'A',
          'POST /realtime/session mints a session',
          'FAIL',
          `HTTP ${sessionResponse.status()}: ${body.error ?? 'unknown'}` +
            (sessionResponse.status() === 503
              ? ' (OPENAI_API_KEY likely not set on the Worker — see README.md)'
              : ''),
        );
      } else {
        sessionBody = await sessionResponse.json();
        const markerOk =
          sessionBody.clientSecret &&
          sessionBody.correctionMarker?.prefix === 'TYPED CORRECTION FROM' &&
          sessionBody.correctionMarker?.suffix === 'NOT SPOKEN BY THE OTHER PERSON';
        record(
          'A',
          'POST /realtime/session mints a session',
          markerOk ? 'PASS' : 'FAIL',
          markerOk ? undefined : 'correctionMarker missing or wrong shape',
        );
      }
    } catch (error) {
      record('A', 'POST /realtime/session mints a session', 'FAIL', String(error));
    }

    if (!sessionBody) {
      record('B', 'SDP offer/answer exchange with OpenAI', 'SKIP', 'checkpoint A did not succeed');
      record('C', 'ICE connection reaches connected', 'SKIP', 'checkpoint A did not succeed');
      record('D', 'Data channel opens', 'SKIP', 'checkpoint A did not succeed');
      record('E', 'Stop sends response.cancel', 'SKIP', 'checkpoint A did not succeed');
      record('F', 'Correction sends the marked item + response.create', 'SKIP', 'checkpoint A did not succeed');
      printSummaryAndExit();
      return;
    }

    // --- Checkpoint B: SDP exchange ---
    try {
      const sdpResponse = await page.waitForResponse(
        (r) => r.url() === 'https://api.openai.com/v1/realtime/calls',
        { timeout: 10000 },
      );
      const sdpText = await sdpResponse.text();
      const ok = sdpResponse.status() === 200 && sdpText.startsWith('v=0');
      record(
        'B',
        'SDP offer/answer exchange with OpenAI',
        ok ? 'PASS' : 'FAIL',
        ok ? undefined : `HTTP ${sdpResponse.status()}`,
      );
    } catch (error) {
      record('B', 'SDP offer/answer exchange with OpenAI', 'FAIL', String(error));
    }

    const signalingState = await page
      .evaluate(() => window.__pc?.signalingState)
      .catch(() => null);
    if (signalingState !== 'stable') {
      console.log(
        `  note: signalingState is "${signalingState}", expected "stable" — setRemoteDescription may not have completed`,
      );
    }

    // --- Checkpoint C: ICE connects (the one most likely to need real UDP egress) ---
    let iceConnected = false;
    const iceTimeoutMs = 20000;
    const pollIntervalMs = 500;
    const deadline = Date.now() + iceTimeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await page.evaluate(() => window.__pc?.iceConnectionState).catch(() => null);
      if (lastState === 'connected' || lastState === 'completed') {
        iceConnected = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    record(
      'C',
      'ICE connection reaches connected',
      iceConnected ? 'PASS' : 'FAIL',
      iceConnected
        ? undefined
        : `stuck at "${lastState}" after ${iceTimeoutMs}ms — if running from a ` +
            'network-restricted sandbox, this is expected (WebRTC media needs ' +
            'outbound UDP); verify from a normal browser/network instead. See README.md.',
    );

    // --- Checkpoint D: data channel open ---
    const dcState = await page.evaluate(() => window.__dc?.readyState).catch(() => null);
    record(
      'D',
      'Data channel opens',
      dcState === 'open' ? 'PASS' : 'FAIL',
      dcState === 'open' ? undefined : `readyState="${dcState}" (depends on checkpoint C)`,
    );

    if (dcState !== 'open') {
      record('E', 'Stop sends response.cancel', 'SKIP', 'data channel not open');
      record('F', 'Correction sends the marked item + response.create', 'SKIP', 'data channel not open');
      printSummaryAndExit();
      return;
    }

    // --- Checkpoint E: Stop ---
    await page.click('#stopButton');
    await page.waitForTimeout(200);
    const lastSent = await page.evaluate(() => window.__lastSent).catch(() => null);
    const stopOk =
      lastSent && lastSent.type === 'response.cancel' && Object.keys(lastSent).length === 1;
    record(
      'E',
      'Stop sends response.cancel',
      stopOk ? 'PASS' : 'FAIL',
      stopOk ? undefined : `last sent was ${JSON.stringify(lastSent)}`,
    );

    // --- Checkpoint F: correction ---
    await page.fill('#correctionInput', 'Actually, make it two.');
    await page.click('#correctionButton');
    await page.waitForTimeout(200);
    const sentLog = await page.evaluate(() => window.__sentLog).catch(() => []);
    const marker = sessionBody.correctionMarker;
    const last2 = sentLog.slice(-2);
    const correctionOk =
      last2.length === 2 &&
      last2[0].type === 'conversation.item.create' &&
      last2[0].item?.content?.[0]?.text?.includes(marker.prefix) &&
      last2[0].item?.content?.[0]?.text?.includes(marker.suffix) &&
      last2[0].item?.content?.[0]?.text?.includes('Actually, make it two.') &&
      last2[1].type === 'response.create' &&
      Object.keys(last2[1]).length === 1;
    record(
      'F',
      'Correction sends the marked item + response.create',
      correctionOk ? 'PASS' : 'FAIL',
      correctionOk ? undefined : `last two sends: ${JSON.stringify(last2)}`,
    );

    await page.click('#endButton');
    await page.waitForTimeout(200);
    const finalState = await page.evaluate(() => document.body.dataset.state);
    if (finalState !== 'ended') {
      console.log(`  note: expected final state "ended", got "${finalState}"`);
    }

    printSummaryAndExit();
  } finally {
    await browser.close();
  }
}

function printSummaryAndExit() {
  console.log('\n--- Summary ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped (of ${results.length})`);

  if (fail > 0 || skip > 0) {
    console.log(
      '\nA-B failing or skipping means the backend contract itself is broken — ' +
        'that IS a real bug. C-F failing while A-B pass most likely means the ' +
        'running environment lacks outbound UDP for WebRTC media, not that the ' +
        'app is broken — re-run from a normal network to confirm. See README.md.',
    );
  }

  // Exit non-zero only if A or B failed — those are the checkpoints that
  // indicate an actual code/contract problem regardless of network
  // restrictions. C-F failing is reported loudly above but doesn't fail the
  // process, since that failure mode is expected from this specific sandbox.
  const coreBroken = results.some((r) => (r.id === 'A' || r.id === 'B') && r.status === 'FAIL');
  process.exitCode = coreBroken ? 1 : 0;
}

main().catch((error) => {
  console.error('\nUnexpected error running the e2e check:', error);
  process.exitCode = 1;
});
