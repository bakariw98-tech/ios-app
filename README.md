# Conversation delegation app

An assistant that helps you say what's hard to say.

**Who it's for:** people who can hear, understand, move, and type fine, but
can't reliably produce live speech in the moment — severe stutter, apraxia,
ALS, post-stroke aphasia, non-verbal autism, selective mutism. Typing is often
their strongest channel; it's specifically live spoken conversation that's
unreliable. Type-a-sentence-and-speak-it AAC apps already exist and aren't
enough, because real conversation is dynamic — a follow-up question means
stopping to type a whole new sentence and making everyone wait. This carries
the live back-and-forth itself.

**Two modes.** In-person is primary: type a quick brief, the AI starts talking
it out loud immediately, live, standing right there with you — ordering food,
asking for a refund, whatever the brief is. It listens and responds to
whatever the other person says without the user re-typing every turn, and
the user can interrupt or correct it with a single tap — never by having to
speak — at any point. Phone-call mode is paused, not removed: call in, get
interviewed privately, merge the other person into the call, the AI speaks
for you within the boundaries you set. See
[ADR-005](docs/technical-decisions.md) for why the pivot, who it's for in
more detail, and what carries over.

## Read these first

| | |
| --- | --- |
| [`docs/technical-decisions.md`](docs/technical-decisions.md) | ADR-005 is the pivot: why in-person mode, the WebRTC architecture, the open echo-cancellation risk. ADR-001–004 are phone mode. |
| [`docs/SETUP.md`](docs/SETUP.md) | Where the Cloudflare/Vapi keys go. Predates the pivot — `OPENAI_API_KEY` (below) isn't in it yet. |
| [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) | Phone-mode scope and locked decisions. Status note at the top points here. |
| [`docs/compliance.md`](docs/compliance.md) | Phone-mode-only. Doesn't apply to in-person mode — see the note at its top. |
| [`e2e/README.md`](e2e/README.md) | Real end-to-end check of in-person mode's WebRTC mechanism against live OpenAI, via the browser client below. Costs real usage — not part of CI. |

**Before changing phone mode's call flow, read `docs/compliance.md`.** The
AI's self-introduction there is not a UX string — it's the mechanism that
mode's compliance rests on. In-person mode has no equivalent step, by design
— see ADR-005 for why that's structural, not a relaxation.

## Layout

```
backend/   Cloudflare Worker (Hono + D1). Both modes' routes, assistants, MCP connector.
ios/       SwiftUI sources. No Xcode project yet — see ios/README.md.
docs/      Brief, compliance reasoning, ADRs.
```

## Backend

Cloudflare Worker backed by D1, deployed by GitHub Actions on push — see
[`docs/SETUP.md`](docs/SETUP.md). Nothing needs to run locally.

```bash
cd backend
npm ci
npm test                  # 125 tests
npm run typecheck
npx wrangler dev          # optional, local only
```

The two modes are fully decoupled in config (`src/lib/config.ts`): a deploy
with only `OPENAI_API_KEY` set boots fine and serves in-person mode; a deploy
with only the four Vapi secrets set boots fine and serves phone mode. Each
mode's routes answer `503` — not a crash — when their own mode isn't
configured. `/health` reports which mode(s) are actually live.

### In-person mode secrets (not yet in docs/SETUP.md)

One Worker secret: `OPENAI_API_KEY` — a real OpenAI API key with Realtime
access. Set it the same way as the Vapi secrets (Cloudflare dashboard →
Workers & Pages → conversation-delegation → Settings → Variables and Secrets).
Nothing else to configure — there's no dashboard-side setup analogous to
Vapi's server URL, because the app talks to OpenAI directly.

**Verify it works at `<worker-url>/web` before building the iOS app.** It's
a browser client implementing the exact same WebRTC protocol as the Swift
client, served straight off this Worker — the fastest way to confirm the
actual mint → WebRTC → live-audio path works before sinking time into an
Xcode project. See [`e2e/README.md`](e2e/README.md) for a scripted check of
the parts that don't need a human in the room; the rest (hearing it talk,
tapping Stop mid-sentence, sending a correction) still needs you.

### Phone mode

`npm test` includes `test/lifecycle.test.ts`, which drives a whole call
through the real webhook with Vapi faked at the `fetch` boundary, and the
safety guards in it are mutation-tested. As of this session, live auth against
real Vapi is confirmed working (`/vapi/webhook` correctly authenticates and
returns a valid assistant config). What was **not** resolved before the pivot:
a real call connected and authenticated, then ended at the same millisecond it
started, with zero transcript — a known Vapi failure signature ("call failed
before it started"), most likely OpenAI Realtime access or credits not
configured on Vapi's own side (`Settings → Provider Keys`) or Vapi account
credits. Whoever picks phone mode back up should start there.

The MCP connector runs separately over stdio:

```bash
npm run mcp
```

It exposes `start_interview`, `get_call_status`, `get_summary` — and
deliberately no `place_call`. Placing a call is always a human action. (Only
meaningful for phone mode.)

## iOS

See [`ios/README.md`](ios/README.md) — it now covers both modes, including the
**required WebRTC package** for in-person mode (Apple ships no first-party
WebRTC framework) and the two biggest open risks: nothing has been compiled
(no Swift toolchain in this environment), and echo cancellation on
speakerphone is a documented-but-unsolved problem that needs a real device to
resolve.

## Where this is up to

**In-person mode (primary):** backend fully built and tested — config
decoupling, brief schema, prompt builder, ephemeral-session minting against
OpenAI's verified API shape, 503-not-crash when unconfigured. iOS: WebRTC
client and UI written but never compiled; the REST handshake follows OpenAI's
documented flow, the WebRTC library calls are the most likely thing to need
fixing on first real build.

**Phone mode (paused):** the three original open technical questions are
answered (ADR-001–003), the merge-window detection design is ADR-004, and as
of this session it's live-deployed with confirmed-working auth. The
instant-end-no-transcript issue above is the actual next step if picked back
up, not another round of webhook/secret debugging.

## Next

1. **In-person mode:** get it into a real Xcode project, add the WebRTC
   package, and find out on a real device whether echo cancellation actually
   holds up on speakerphone. That answer matters more than anything else left
   to build — see ADR-005.
2. **Phone mode, if resumed:** check Vapi's Provider Keys / billing for the
   OpenAI Realtime access that a call needs after our webhook already succeeds.
3. Engage counsel before opening phone mode past a small pilot (in-person
   mode's compliance analysis is different — see ADR-005 — but hasn't had the
   same scrutiny applied yet either).
