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
  pre-installed sandbox Chromium at `/opt/pw-browsers/chromium`, which is a
  symlink to the binary itself, not a directory; on a normal machine with
  Playwright's browsers installed via `npx playwright install chromium`,
  point this at that binary instead).
- `VERBOSE=1` — echo the page's own `console.log` output as it runs, useful
  for debugging a stuck checkpoint.

## The page now opens a typed intake step first

Before minting a session, `/web` runs a short typed back-and-forth
(`POST /intake/turn`, see `backend/src/domain/inPersonIntake.ts` and ADR-005's
intake amendment in `docs/technical-decisions.md`). This script deliberately
does not drive that conversation — it clicks `#skipButton` the moment the
page reaches `data-state="intake"`, and goes straight on to checkpoint A from
there. That's on purpose: this script proves the WebRTC/live-session
contract, not the intake LLM (that's covered by `backend/test/intake.test.ts`'s
faked-fetch suite), and driving through Skip keeps each run at exactly one
billable OpenAI operation instead of also spending intake completions.

A useful side effect: `#skipButton` going missing or renamed by a future
`web.ts` change surfaces here as a checkpoint-A timeout, not a mysterious
hang. If A starts failing right after touching the intake screen, check that
first before assuming the realtime contract itself broke.

## What the checkpoints mean

Results print per-checkpoint (`PASS`/`FAIL`/`SKIP`), not as one aggregate
boolean, because "the contract works but media didn't connect from this
network" is a materially different, useful result from "the app is broken."

| # | Checks | Needs only HTTPS? |
|---|---|---|
| A | `POST /realtime/session` → 200, real `clientSecret`, `correctionMarker` matches the source-of-truth strings in `backend/src/domain/inPersonBrief.ts` | Yes |
| B | `POST https://api.openai.com/v1/realtime/calls` → 2xx (OpenAI answers `201`, not `200` — the check matches what the shipped clients actually do: `response.ok`), SDP-shaped answer, `pc.signalingState === 'stable'` | Yes, **from the browser itself** — see below |
| C | `pc.iceConnectionState` reaches `connected`/`completed` | **No — needs outbound UDP** |
| D | data channel `"oai-events"` reaches `readyState === 'open'` | No — depends on C |
| E | tapping Stop sends exactly `{"type":"response.cancel"}` on the data channel | No — depends on C/D |
| F | submitting a correction sends `conversation.item.create` (text wrapped in the marker from `session.correctionMarker`) then `response.create`, in that order | No — depends on C/D |

Before checkpoint A, the script probes whether the launched browser can
complete a TLS handshake to an external host at all (`https://api.openai.com/`).
If it can't, that's printed up front, and a checkpoint-B failure is reported
as *that*, not as a broken contract — see below for why this probe exists.

The script only exits non-zero if **A** fails, or **B** fails while that
probe says the browser *can* reach external HTTPS — those indicate an actual
code or contract problem regardless of network restrictions. Everything else
(C–F, or B when the probe already failed) is reported loudly but does not
fail the process, because that failure mode is an environment limitation,
not a claim that the app is broken.

## Why B, and not just C–F, may legitimately fail here

WebRTC's real media and the `oai-events` data channel ride on UDP
(ICE/DTLS-SRTP), which is why C–F can fail on a UDP-restricted network — see
below. But this script also found something less expected: in the sandbox it
was built in, **headless Chromium's own TLS handshakes to any external HTTPS
host were reset**, even though the exact same host was reachable fine from
curl and from raw Node `net`/`tls` sockets run in that same shell. Confirmed
with Chromium's own `--log-net-log`: `SSL_HANDSHAKE_ERROR`, `net_error: -101`
(`ERR_CONNECTION_RESET`), `os_error: 104` (`ECONNRESET`) — happening at the
TLS layer itself, after the CONNECT tunnel to the proxy was already
established successfully. Plain HTTP through the same proxy worked fine from
Chromium; only HTTPS to an external host failed. That strongly suggests a
TLS-fingerprint-based egress policy in that sandbox that allows script-like
clients (curl, Node) through but resets a real browser engine's handshake —
not anything wrong with this app, and not the same mechanism as the UDP
restriction below, which is why checkpoint B needed its own detection rather
than being lumped in with C–F.

**This does not mean checkpoint B is unverifiable in general** — only that a
sandbox with this specific restriction can't verify it via a real headless
browser. In that situation, the underlying HTTP contract can still be proven
by hand: capture the real SDP offer the page generates
(`window.__pc.localDescription.sdp`, readable via `page.evaluate` any time
after the page attempts and fails its own POST) together with the
`clientSecret` from checkpoint A's response, then replay that exact offer
against `https://api.openai.com/v1/realtime/calls` with `curl` from the same
shell. Doing exactly this against the real live Worker got back `201` and a
genuine SDP answer — proving the contract works even though this script
can't demonstrate it end-to-end from that environment.

## Why C–F may legitimately fail here

This script has been run from a sandbox where HTTPS egress to
`api.openai.com` works (confirmed live, including from the browser once B's
issue above is accounted for) but raw UDP does not — a STUN binding request
and an NTP query both timed out with no reply, while the equivalent HTTPS
call succeeded instantly. In that environment, expect A and B to pass (once
the TLS restriction above isn't present) and C–F to fail with a "stuck at
..." message that says outright this is likely a network restriction, not an
app bug.

**If C–F fail, that is not proof the app works — it's an inconclusive
result.** The only real proof is a human opening `/web` on their own
device/network, hearing the AI talk, tapping Stop mid-sentence and
confirming it's instant, and typing a correction and confirming it's
followed. This script exists to catch backend/contract regressions cheaply
and often; it is not a substitute for that manual pass before shipping.

# Phone mode (Twilio migration): relay end-to-end check

`twilio-relay.mjs` is the equivalent script for the Twilio Media Streams
relay (`CallRelay`, see `docs/technical-decisions.md` ADR-006) — a plain
Node script using the built-in `WebSocket` client (stable since Node 22), no
browser involved, so none of the Chromium TLS/UDP issues above apply here.

## Prerequisites

1. `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, and
   `PUBLIC_SERVER_URL` must be set as secrets on the deployed Worker, and
   `OPENAI_API_KEY` must already be set (Twilio phone mode depends on both —
   see `lib/config.ts`'s file-level doc comment).
2. `GET <worker-url>/health` must show `"modes": {"phoneTwilio": true, ...}`.
3. Buy a Twilio phone number and point its **Voice** webhook at
   `<worker-url>/twilio/voice` (`HTTP POST`) — this script never touches
   Twilio's API to do that for you; it only simulates what Twilio's own
   infrastructure would send.

## Running it

```sh
cd e2e
TWILIO_ACCOUNT_SID=ACxxxxxxxx TWILIO_AUTH_TOKEN=your-auth-token npm run test:twilio
```

(or `node twilio-relay.mjs` directly — see `package.json`). Both env vars
must match exactly what's configured as secrets on the Worker; this script
uses them only to compute the same request signature a real Twilio webhook
would send, never to call Twilio's own API.

## What it checks, and what it deliberately doesn't

Checkpoints A–C exercise `POST /twilio/voice`: secrets present, a
correctly-signed request returns 200, and the response TwiML points at a
live stream URL rather than a `<Reject>` (bad signature) or `<Hangup>`
(Twilio/OpenAI not configured — reported as a SKIP, not a FAIL, since that's
an expected state before setup is finished, not a bug). Checkpoints D–E open
that stream URL as a fake Twilio Media Streams client, send a synthetic
`start` event, and confirm real audio comes back — the `CallRelay` DO speaks
first (see its doc comment), so this works without needing to send real
human speech as input.

**What this cannot prove, and does not try to:** that a real PSTN call
sounds intelligible end to end, that Twilio's actual infrastructure frames
audio identically to this script's synthetic frames, or that a real phone's
mixed audio reliably triggers the same VAD/barge-in behavior a clean
synthetic stream does. Per the Twilio migration plan's own Phase 2
verification step: run this script first to narrow down where a problem is,
then place an actual phone call — this script is a fast, cheap first check,
not a replacement for that call.
