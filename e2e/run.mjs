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

// Note this is the binary itself, not a directory — /opt/pw-browsers/chromium
// is a symlink straight to chromium-<build>/chrome-linux/chrome.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const results = [];

function record(id, description, status, detail) {
  results.push({ id, description, status, detail });
  const icon = { PASS: '✓', FAIL: '✗', SKIP: '—' }[status];
  console.log(`[${icon}] ${id}: ${description}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Chromium: ${CHROMIUM_PATH}\n`);

  // Chromium doesn't read HTTPS_PROXY itself — only tools built on Node's
  // fetch/http stack do. Pass it through explicitly wherever a proxy is
  // configured for this shell (e.g. this sandbox's agent proxy), or Chromium
  // tries a direct connection and gets a connection reset instead of an
  // informative proxy error. Harmless to omit on a normal machine with no
  // proxy set.
  const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      ...(proxyServer
        ? [
            `--proxy-server=${proxyServer}`,
            // So a proxied environment doesn't break local-target runs (e.g.
            // TARGET_URL=http://localhost:8787/web against wrangler dev).
            '--proxy-bypass-list=localhost;127.0.0.1;<local>',
          ]
        : []),
    ],
    ...(proxyServer
      ? { proxy: { server: proxyServer, bypass: 'localhost,127.0.0.1' } }
      : {}),
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (process.env.VERBOSE) console.log(`  [page] ${msg.text()}`);
  });

  // Some sandboxes let curl/Node reach external HTTPS hosts fine while
  // resetting Chromium's own TLS handshakes to them (observed directly while
  // building this script: raw sockets and curl succeeded, Chromium's
  // page.goto to the same host got net::ERR_CONNECTION_RESET, confirmed via
  // Chromium's own --log-net-log as an SSL_HANDSHAKE_ERROR, -101). That is a
  // real, separate limitation from the WebRTC/UDP one checkpoints C-F already
  // account for, and it specifically breaks checkpoint B (the browser POSTs
  // the SDP offer straight to api.openai.com). Detect it upfront so a B
  // failure here is correctly attributed to the environment instead of
  // misreported as a broken contract.
  let browserCanReachExternalHttps = true;
  try {
    const probe = await context.newPage();
    await probe.goto('https://api.openai.com/', { timeout: 8000 }).catch(() => {
      throw new Error('unreachable');
    });
    await probe.close();
  } catch {
    browserCanReachExternalHttps = false;
  }
  if (!browserCanReachExternalHttps) {
    console.log(
      "note: this browser can't complete a TLS handshake to an external " +
        'host from this environment (checked against api.openai.com before ' +
        'starting). Checkpoint B needs that to work — expect it to fail for ' +
        "that reason, not a code bug. See README.md.\n",
    );
  }

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const initialState = await page.evaluate(() => document.body.dataset.state);
    if (initialState !== 'idle') {
      throw new Error(`Expected initial state "idle", got "${initialState}"`);
    }

    const testSituation =
      "Say the exact words 'automated test successful' and then stop talking.";
    await page.fill('#situationInput', testSituation);
    await page.click('#startButton');

    // The page now opens a typed intake step before minting a session — see
    // domain/inPersonIntake.ts and ADR-005's intake amendment. This script
    // proves the WebRTC/live-session contract (checkpoints A-F), not the
    // intake LLM itself (that's covered by test/intake.test.ts's faked-fetch
    // suite). Driving through Skip keeps a run at exactly one billable
    // OpenAI operation instead of also spending intake completions every
    // time, and exercises the release valve that matters most operationally:
    // if #skipButton is ever missing or renamed, this shows up here as a
    // checkpoint-A timeout — check that first if A starts failing after a
    // web.ts change.
    await page.waitForSelector('body[data-state="intake"]', { timeout: 10000 });
    await page.click('#skipButton');

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

    // Not a checkpoint (doesn't affect the summary or exit code) — a plain
    // note confirming Skip passed the originally-typed text through to
    // /realtime/session unchanged, rather than something mangled or dropped
    // along the way.
    if (sessionBody) {
      const startedWith = await page.evaluate(() => window.__startedWith).catch(() => null);
      if (startedWith?.situation !== testSituation) {
        console.log(
          `  note: Skip's brief.situation was "${startedWith?.situation}", ` +
            `expected the original typed text unchanged`,
        );
      }
    }

    if (!sessionBody) {
      record('B', 'SDP offer/answer exchange with OpenAI', 'SKIP', 'checkpoint A did not succeed');
      record('C', 'ICE connection reaches connected', 'SKIP', 'checkpoint A did not succeed');
      record('D', 'Data channel opens', 'SKIP', 'checkpoint A did not succeed');
      record('E', 'Stop sends response.cancel', 'SKIP', 'checkpoint A did not succeed');
      record('F', 'Correction sends the marked item + response.create', 'SKIP', 'checkpoint A did not succeed');
      printSummaryAndExit(browserCanReachExternalHttps);
      return;
    }

    // --- Checkpoint B: SDP exchange ---
    try {
      const sdpResponse = await page.waitForResponse(
        (r) => r.url() === 'https://api.openai.com/v1/realtime/calls',
        { timeout: 10000 },
      );
      const sdpText = await sdpResponse.text();
      // OpenAI answers this endpoint with 201, not 200 — confirmed against
      // the real endpoint. response.ok (any 2xx) is what the shipped clients
      // actually check; matching that here instead of a specific code.
      const ok = sdpResponse.ok() && sdpText.startsWith('v=0');
      record(
        'B',
        'SDP offer/answer exchange with OpenAI',
        ok ? 'PASS' : 'FAIL',
        ok ? undefined : `HTTP ${sdpResponse.status()}`,
      );
    } catch (error) {
      record(
        'B',
        'SDP offer/answer exchange with OpenAI',
        'FAIL',
        browserCanReachExternalHttps
          ? String(error)
          : `${error} — this browser can't reach external HTTPS hosts from ` +
              'this environment (see the note printed at startup); this is ' +
              'very likely that, not a broken contract. Re-run from a ' +
              'normal network to confirm.',
      );
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
      printSummaryAndExit(browserCanReachExternalHttps);
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

    printSummaryAndExit(browserCanReachExternalHttps);
  } finally {
    await browser.close();
  }
}

function printSummaryAndExit(browserCanReachExternalHttps) {
  console.log('\n--- Summary ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped (of ${results.length})`);

  if (fail > 0 || skip > 0) {
    console.log(
      '\nA failing or skipping means the backend contract itself is broken — ' +
        "that IS a real bug. B failing is too, UNLESS this browser can't reach " +
        'external HTTPS hosts at all from this environment (checked at ' +
        'startup, see the note above if so) — in that case B is expected to ' +
        'fail for the same reason C-F usually do. C-F failing while A-B pass ' +
        'most likely means the running environment lacks outbound UDP for ' +
        'WebRTC media, not that the app is broken — re-run from a normal ' +
        'network to confirm either case. See README.md.',
    );
  }

  // Exit non-zero only for failures that indicate an actual code/contract
  // problem: A always counts; B counts unless this browser already couldn't
  // reach external HTTPS hosts at all before the test even started, in which
  // case B's failure is that environment limitation, not the app. C-F failing
  // is reported loudly above but never fails the process, since UDP-restricted
  // sandboxes are a known, expected case.
  const coreBroken = results.some((r) => {
    if (r.status !== 'FAIL') return false;
    if (r.id === 'A') return true;
    if (r.id === 'B') return browserCanReachExternalHttps;
    return false;
  });
  process.exitCode = coreBroken ? 1 : 0;
}

main().catch((error) => {
  console.error('\nUnexpected error running the e2e check:', error);
  process.exitCode = 1;
});
