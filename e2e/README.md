# In-person mode: real end-to-end check

This is a manual, occasionally-run script that drives the actual browser
test client (`GET /web` on the Worker, see `backend/src/routes/web.ts`) in
headless Chromium and talks to a **live backend and real OpenAI Realtime
API**. Nothing else in this repo does that — every test under `backend/test`
fakes the OpenAI call at the `fetch` boundary. This is the only thing that
proves the mint → WebRTC → live session path actually works.

It is deliberately kept outside `backend/` and outside CI:

- It costs real OpenAI usage every time it runs.
- It needs a live `OPENAI_API_KEY` configured on the Worker.
- `backend/test` is Vitest scoped to `backend/`; this directory has its own
  `package.json` so nothing here can accidentally get swept into `npm test`
  or `deploy.yml`.

**Never wire this into `.github/workflows/deploy.yml` or any other
push-triggered job.** If a repeatable, scripted check of checkpoints C–F is
ever wanted, the right shape is a separate `workflow_dispatch`-only GitHub
Action (GitHub-hosted runners generally allow outbound UDP, unlike some
sandboxes) — not a change to this script's triggering.

## Prerequisites

1. `OPENAI_API_KEY` must be set as a secret on the deployed Worker.
2. `GET <worker-url>/health` must show `"modes": {"inPerson": true, ...}`.
   If it shows `false`, every checkpoint here fails at A with an HTTP 503 —
   that's expected, not a bug in this script; go set the secret first.
3. The OpenAI account behind that key must actually have Realtime API access
   and available credits.

## Running it

```sh
cd e2e
npm install
npm test
```

By default this targets the live Worker's `/web`
(`https://conversation-delegation.bakariw98.workers.dev/web`). Point it
elsewhere (e.g. `wrangler dev`) with:

```sh
TARGET_URL=http://localhost:8787/web npm test
```

Other env vars:

- `CHROMIUM_PATH` — override the Chromium binary (defaults to the
  pre-installed sandbox Chromium at
  `/opt/pw-browsers/chromium/chrome-linux/chrome`; on a normal machine with
  Playwright's browsers installed via `npx playwright install chromium`,
  point this at that binary instead).
- `VERBOSE=1` — echo the page's own `console.log` output as it runs, useful
  for debugging a stuck checkpoint.

## What the checkpoints mean

Results print per-checkpoint (`PASS`/`FAIL`/`SKIP`), not as one aggregate
boolean, because "the contract works but media didn't connect from this
network" is a materially different, useful result from "the app is broken."

| # | Checks | Needs only HTTPS? |
|---|---|---|
| A | `POST /realtime/session` → 200, real `clientSecret`, `correctionMarker` matches the source-of-truth strings in `backend/src/domain/inPersonBrief.ts` | Yes |
| B | `POST https://api.openai.com/v1/realtime/calls` → 200, SDP-shaped answer, `pc.signalingState === 'stable'` | Yes |
| C | `pc.iceConnectionState` reaches `connected`/`completed` | **No — needs outbound UDP** |
| D | data channel `"oai-events"` reaches `readyState === 'open'` | No — depends on C |
| E | tapping Stop sends exactly `{"type":"response.cancel"}` on the data channel | No — depends on C/D |
| F | submitting a correction sends `conversation.item.create` (text wrapped in the marker from `session.correctionMarker`) then `response.create`, in that order | No — depends on C/D |

The script only exits non-zero if **A or B** fail — those indicate an actual
code or contract problem regardless of network restrictions. C–F failing is
reported loudly (with an explanation, not a bare timeout) but does not fail
the process, because that failure mode is expected from a UDP-restricted
sandbox and says nothing about whether the app itself is broken.

## Why C–F may legitimately fail here

WebRTC's real media and the `oai-events` data channel both ride on UDP
(ICE/DTLS-SRTP), not HTTPS. This script has been run from a sandbox where
HTTPS egress to `api.openai.com` works (confirmed live) but raw UDP does
not — a STUN binding request and an NTP query both timed out with no reply,
while the equivalent HTTPS call succeeded instantly. In that environment,
expect A and B to pass and C–F to fail with a "stuck at ..." message that
says outright this is likely a network restriction, not an app bug.

**If C–F fail, that is not proof the app works — it's an inconclusive
result.** The only real proof is a human opening `/web` on their own
device/network, hearing the AI talk, tapping Stop mid-sentence and
confirming it's instant, and typing a correction and confirming it's
followed. This script exists to catch backend/contract regressions cheaply
and often; it is not a substitute for that manual pass before shipping.
