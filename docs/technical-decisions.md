# Technical decisions

Answers to the three open questions carried into this session. Researched against
Vapi's documentation on 2026-08-05; re-verify before relying on any of it, since
Vapi's transfer surface has been moving.

---

## ADR-001 — How the recipient joins the call

**Question:** Does Vapi support call transfer / add-participant in a way that
cleanly supports "user merges in the recipient mid-call"?

### Answer: No. Vapi has no add-participant primitive, and every transfer mode it does have removes the assistant from the call.

This is the most important finding of the session, because the brief's step 4
assumed this was a Vapi feature. It is not.

What Vapi actually exposes on a live call ([Live Call Control][cc]) is exactly
six control-message types:

`say`, `add-message`, `control` (mute/unmute/say-first-message), `end-call`,
`transfer`, `handoff`.

There is no conference primitive and no "add participant." And the transfer modes
are all *hand-off-and-leave* semantics:

- **Assistant-based warm transfer** (`warm-transfer-experimental`) spins up a
  dedicated transfer assistant, and on success works by "merging the customer and
  operator calls" and **"removing the transfer assistant from the call."** ([docs][awt])
- The other warm-transfer modes (e.g.
  `warm-transfer-wait-for-operator-to-speak-first-and-then-say-summary`) keep the
  AI in the Twilio conference only *until* the operator answers and speaks — the
  AI is a context-passing intermediary, then it drops.
- Vapi + Twilio conferencing ([docs][twilio]) hands control **away from Vapi** to
  Twilio's native conferencing once the third leg is dialed. The pattern is
  `/inbound_call` → `/connect` → `/conference`, and Vapi's direct involvement
  ends there.

Every one of these is the wrong shape for this product. We need the AI to *stay*
and become the primary speaker to the newly-joined party. Vapi's transfers are
built for the opposite: the AI leaves and the humans talk.

### Decision: native carrier conference, user-driven (Option A)

The user, in the iOS Phone app:

1. calls our Vapi number (interview happens),
2. taps **Add Call**, dials the recipient,
3. taps **Merge Calls**.

The carrier mixes the audio. From Vapi's perspective nothing happened — it is
still the same single inbound call — but the assistant can now hear and speak to
both parties.

**Why this and not a server-dialed leg:** any path where our infrastructure dials
the recipient is a server-initiated outbound leg, which the brief rules out
absolutely (N4 in [`compliance.md`](./compliance.md)). Native carrier merge is the
only mechanism where the recipient's leg is initiated entirely by the human, on
their own device, with zero server involvement. It happens to be both the
legally strongest option and the one the brief already describes.

### Consequences — read these, they are not small

- **Carrier-dependent.** Three-way calling over native merge works on VoLTE/GSM
  on the major US carriers, but it is not universal, and it is not available at
  all on some MVNOs and some Wi-Fi-calling paths. This needs a real device matrix
  before launch. **This is the single largest delivery risk in v1.**
- **Not programmatically triggerable.** There is no CallKit API to merge calls on
  the user's behalf. The app can only *instruct* — and in practice the assistant
  coaches it out loud, live, one step at a time, which works better than a
  screen someone is not looking at mid-call. `MergeGuideView` is the reference
  copy, not the primary teaching surface.
- **Detectable by ear, not by API.** See ADR-004 — this turned out better than
  first assessed.
- If the device matrix comes back bad, the fallback is not "let the server dial."
  It is to revisit the flow with counsel, per the revisit triggers in
  `compliance.md`.

### Rejected: Option B — server dials the recipient into a conference

Technically easy, and post-*Facebook v. Duguid* (2021) the ATDS prong likely
would not bite, since dialing one specific stored number is not random or
sequential number generation. **But that does not save it:** TCPA's
artificial-or-prerecorded-voice prong applies independently of whether an
autodialer was used, and it wants consent obtained *prior to* the call. Our
verbal consent happens after the recipient has already been dialed and connected.
Option A avoids the question entirely by never having our systems place the call.

---

## ADR-002 — One session or two assistants

**Question:** Does the interview (step 2) and the live conversation (step 6) run
as one continuous Vapi assistant/session, or a handoff between two assistant
configs?

### Answer: one phone call, two assistant configs, joined by the handoff tool.

Vapi's [handoff tool][handoff] transfers between assistants **within the same
call/session** — the connection is not dropped. That gives us the best of both:
one continuous PSTN call (required, since the carrier conference is anchored to
it) with two cleanly separated prompt/tool configurations.

Two assistants rather than one, because the two phases are genuinely different
jobs with different risk profiles:

| | Interview assistant | Delegate assistant |
| --- | --- | --- |
| Audience | The user, privately | The recipient (and the user) |
| Goal | Elicit intent and boundaries | Deliver it faithfully |
| Tone | Curious, drawing out | Composed, representative |
| Must not | Give advice, judge | Improvise beyond intent, claim humanity |
| First words | Warm greeting | **The mandatory disclosure** |

Cramming both into one prompt would mean the disclosure is a mid-conversation
instruction the model may or may not follow. Splitting them means the disclosure
is the delegate assistant's `firstMessage` with
`firstMessageMode: "assistant-speaks-first"` — **spoken before the model gets a
turn at all.** That converts our central compliance mechanism from a prompt
request into a structural guarantee. That is the real reason for two assistants.

### Carrying the intent object across the handoff

The handoff tool supports `variableExtractionPlan` — a JSON Schema evaluated
against the conversation before the handoff, whose results are available to the
next assistant via Liquid (`{{variableName}}`). This is precisely the brief's
"internal intent object," and it is a native feature rather than something we
build. Schema lives in `backend/src/domain/intent.ts`.

`contextEngineeringPlan` controls how much raw history crosses over. We use
`previousAssistantMessages`-style narrowing rather than `all`: the delegate
should work from the *structured intent*, not from the full emotional transcript
of the interview. The user told us things in confidence during step 2; the
delegate does not need — and should not have — all of it in-context while a third
party is listening.

### Triggering the handoff

See ADR-004. The original design used an agreed spoken phrase; it now triggers
primarily on the assistant hearing the recipient arrive, with the phrase as one
of several fallbacks.

---

## ADR-004 — Detecting that the recipient joined

**Supersedes the "not programmatically detectable" conclusion in ADR-001.**

### What's actually available

Three things are true, and they point in different directions:

1. **Vapi's `transcript` webhook carries only `role: "user" | "assistant"`.** No
   speaker id, no channel, no diarization label. And because the carrier mixes
   the conference onto one mono inbound leg, *the user and the recipient both
   arrive as `role: "user"`.* There is no labeled signal in the webhook stream.
2. **But the realtime model hears the raw audio.** `gpt-realtime` is
   speech-to-speech; it receives the audio directly, not a transcript. A
   different voice saying "Hello?" is highly salient to it. This is real
   detection — it is just model judgement rather than a flag.
3. **Deepgram diarization exists but doesn't reach us.** Nova-3 diarizes mono
   multi-speaker audio (that is the point of diarization), but Vapi does not
   surface the speaker label in the transcript event, so we cannot read it.

### Decision: arm on intent, detect to time it

The tempting design is "detect the recipient, then disclose." Its failure mode
is the one thing this product must never do: detection misses, the assistant
keeps talking to the user *about their situation*, and the recipient is silently
listening, undisclosed.

So the window is **armed on intent, not on detection**:

- The instant the assistant starts coaching the merge, it calls `arm_for_merge`.
- From then until handoff, the only things it may say are merge coaching and the
  disclosure. It is told to **assume the recipient can already hear it**.
- Detection then decides *when* the disclosure fires — never *whether*
  something else could slip out first.

This makes both failure modes safe:

| | Cost |
| --- | --- |
| Missed the join | Assistant stays quiet; user says "they're on". A few awkward seconds. **Nothing leaks.** |
| False alarm | Disclosure delivered to the user. Mild confusion, cleared up in one sentence. **Nothing leaks.** |

Because both are safe, the model is explicitly instructed to resolve uncertainty
toward handing off. That instruction is only defensible *because* of the arming
inversion — without it, "when in doubt, speak" would be reckless.

### Triggers, any of which fires the handoff

1. The assistant hears a voice that isn't the user's *(primary)*
2. It hears a greeting — "hello?", "who is this?" *(primary)*
3. The user says the recipient is on *(fallback)*
4. The assistant is simply unsure *(fallback)*
5. Server backstop: a `role: "user"` transcript matching a
   pick-up-the-phone greeting, or the assistant breaking quiet mode, while
   armed → the backend speaks the disclosure itself over the control URL

Trigger 5 should never fire. When it does it is logged at error level with the
call id, because it means the model heard someone arrive and failed to act. It
is a bug to investigate, not a metric to aggregate. `arm_for_merge` takes the
user's first name precisely so the server can build the disclosure unaided at
that moment.

### A nice side effect

The user no longer needs to remember a magic phrase. The recipient says
"Hello?", and the assistant introduces itself — which is what a person would do,
and removes the most artificial beat in the flow.

### Upgrade path if the model's ear proves unreliable

Vapi exposes `listenUrl`, a WebSocket stream of live call audio. We could
consume it server-side, run streaming diarization (Deepgram `diarize: true`),
and fire the handoff the moment the speaker count goes 1 → 2. That is a hard
programmatic signal rather than a judgement call.

Not built for v1: it is real infrastructure, diarization needs a few seconds of
a new speaker before the label stabilises, and the model's ear is likely good
enough. Revisit if live calls show missed joins.

One flag if we do build it: ephemeral speaker clustering is not voiceprinting,
but Illinois BIPA regulates "voiceprints" and the line is worth checking with
counsel before persisting anything derived from a recipient's voice.

### Adjacent, unresolved

Vapi records calls by default (`recordingUrl` in the end-of-call artifacts).
Several states require all-party consent to *record*, which is a separate
question from consent to talk to an AI — the disclosure covers the latter, not
obviously the former. Not addressed here. Worth resolving before a pilot; the
cheap fix is disabling recording, and the cheaper-still fix is adding recording
to the disclosure's consent question.

---

## ADR-003 — Post-call summary webhook design

**Question:** Webhook design for the post-call summary generation.

### Answer: lean on `analysisPlan` + the `end-of-call-report` event; do not build our own summarizer.

Vapi runs [call analysis][analysis] in the background as soon as a call ends
(typically a few seconds) and delivers it in the `end-of-call-report` server
event. We configure three plans on the delegate assistant:

- **`summaryPrompt`** → lands in `call.analysis.summary`. Prompted to write to
  *the user*, in second person, about how their message landed.
- **`structuredDataPrompt` + `structuredDataSchema`** → `call.analysis.structuredData`.
  This is what step 8 of the flow actually needs, as fields rather than prose:
  what was communicated, what the recipient said, whether the goal was achieved,
  whether boundaries held, whether the disclosure was delivered and consent given.
- **`successEvaluationPrompt` + rubric** → `call.analysis.successEvaluation`.

Building our own post-call summarizer would mean a second LLM pass over a
transcript Vapi has already analyzed, for no gain.

### Webhook surface

One endpoint, `POST /vapi/webhook`, switching on `message.type`:

| Event | What we do |
| --- | --- |
| `status-update` | Track call lifecycle; expose via `get_call_status`. |
| `transcript` | Live transcript buffer; used for the in-app chat view. |
| `tool-calls` | Handle interview-side tools (e.g. safety escalation). **Must respond.** |
| `end-of-call-report` | Persist transcript, recording, analysis. Fire the user's summary. |
| `handoff-destination-request` | Resolve the delegate assistant. **Must respond.** |

Four event types require a response, and `assistant-request` in particular has a
**7.5 second budget** — so the handler must never do slow work inline on those
paths.

Signature verification on every request; the secret is configured as a Vapi
server-URL header. Unverified requests are dropped, not logged with bodies.

### Compliance auditing rides on this

`structuredDataSchema` includes `disclosureDelivered` and `consentObtained` as
required booleans. Every completed call therefore produces a machine-checkable
record that N1 and N3 were satisfied. `backend/src/routes/webhook.ts` flags any
call where either is false — that is a bug in the disclosure path and needs to be
looked at immediately, not aggregated into a dashboard.

---

## ADR-005 — Pivot: in-person mode becomes primary, phone-call mode pauses

**Decision, from the user, verbatim redirect:** build a new v1 target — the
user types or speaks a brief, the AI starts talking it out loud immediately,
live, in person. No phone, no dialing, no call merge. If the other person
responds, the AI hears it through the phone's mic and answers live. The AI
only pauses to ask the user something when it hits a decision only they can
make. Phone-call mode (Vapi, Twilio, merge, disclosure) is paused, not
scrapped — same underlying Realtime engine, wired back in later as a second
entry point.

This session's earlier work (ADR-001 through ADR-004, the whole compliance
apparatus in `docs/compliance.md`) is about **phone-call mode specifically**
and stays intact, unmodified, and reachable. None of it applies to in-person
mode, for a structural reason below, not because it was relaxed.

### Why in-person mode needs none of the phone-mode compliance machinery

Phone-call mode's entire apparatus — the merge window, the mandatory
disclosure, the consent gate, the interview/delegate split — exists to solve
one problem: a recipient who didn't expect the call is about to hear an AI
speak, and TCPA plus basic decency require they be told what's happening and
agree to continue *before* anything substantive is said (see
`docs/compliance.md`).

In-person mode has no equivalent problem, structurally, not by policy
choice:

- **There is no telephony call.** TCPA governs calls to a phone. This is a
  live voice interaction happening in the same physical room. It doesn't
  reach a "call" in any interpretation that matters here.
- **There is no private phase to protect.** Phone mode's merge window exists
  because the interview is private and the recipient must never overhear it
  unconsented. Here, the user is standing right there for the entire
  interaction — there's nothing said that they didn't just say themselves,
  moments earlier, to the same device.
- **The closest existing category is assistive/AAC technology**, not
  telemarketing: a speech-generating device for someone who can't or would
  rather not say something themselves, operated in the open, by the person
  it represents, who is present the whole time. Existing AAC devices carry no
  disclosure requirement, and this doesn't either.

None of that is a loophole being exploited — it's the actual shape of the
product being different enough that the phone-mode reasoning doesn't
transfer. If a future feature blurs this (e.g. leaving the phone with the
other party, or the user stepping away mid-conversation), that changes the
analysis and needs revisiting against `docs/compliance.md`'s reasoning
before shipping.

### Architecture: direct OpenAI Realtime over WebRTC, not Vapi

Vapi added value for phone mode specifically — a phone number, PSTN
bridging, and Realtime session orchestration over a call that doesn't exist
here. There's no telephony leg to orchestrate, so there's no reason to pay
Vapi's middleman cost or inherit its constraints (see ADR-001's whole
saga). Instead:

1. iOS app POSTs the brief to our backend (`POST /realtime/session`).
2. Backend holds the real `OPENAI_API_KEY` and calls OpenAI's
   `POST /v1/realtime/client_secrets` to mint a short-lived client secret,
   pre-configured with the session's `instructions`, `model`, and `voice`.
   Verified against
   [developers.openai.com/api/docs/guides/realtime-webrtc][rtwebrtc] on
   2026-08-06.
3. Backend returns that ephemeral secret to the app — never the real key.
4. The app opens a WebRTC peer connection **directly to OpenAI**, using the
   ephemeral secret: create an offer, POST the SDP as `application/sdp` to
   `https://api.openai.com/v1/realtime/calls` with
   `Authorization: Bearer <ephemeral>`, apply the SDP answer that comes back.
5. Audio flows client ↔ OpenAI directly from there. This Worker never
   touches it.

This is the architecture OpenAI itself documents for client apps (mint
server-side, connect client-side), and it's the only sane one available:
Cloudflare Workers can't relay raw WebRTC media, so a "backend proxies the
audio" design was never on the table.

### The real open risk: echo cancellation on speakerphone

The AI's voice comes out the phone's own speaker; the same phone's mic has
to pick up the *other* person's voice without also picking up the AI talking
to itself. WebRTC ships built-in echo cancellation (enabled here via
`AVAudioSession`'s `.voiceChatSpeaker` mode, which is what actually engages
iOS's own AEC for a same-device speaker/mic pair), but multiple developers
report this is only partially solved in practice on real devices in
speakerphone-like scenarios — the model can hear and interrupt itself
mid-sentence.

This is treated the same way carrier-dependent three-way calling was treated
in ADR-001: named as the single largest delivery risk, not silently assumed
solved. It can only be resolved with a real device, in a real noisy room,
not by reasoning about it further from source code. See `ios/README.md` for
the fallback option (wired earpiece, not built) if it proves insufficient.

### What carries over from phone mode, and what doesn't

Carries over: the underlying Realtime API, the general shape of "give the
model a brief, let it speak for you, keep it within what it was actually
told." The delegate assistant's boundary-following instinct
(`assistants/delegate.ts`'s `CONDUCT_RULES`) inspired the equivalent rules in
`domain/inPersonBrief.ts`, rewritten for a live in-the-room exchange rather
than a hard message delivered once.

Does not carry over, deliberately: the two-assistant split, the merge
window, the disclosure string, the consent gate, the intent-object interview
step. In-person mode is one continuous session from a single brief — there's
no separate private phase to hand off *from*.

### Config decoupling this required

Before this pivot, `buildConfig` treated the four Vapi secrets as globally
required — the whole Worker refused to boot without them. That's now wrong:
an in-person-only deploy shouldn't need Vapi configured at all. `vapi` and
`openai` are now independent optional blocks in `Config`; each route checks
only the block it needs and answers `503` (not a 500 crash) if its mode
isn't configured. See `backend/src/lib/config.ts`.

### Amendment — who this is for, and a wrong assumption it corrected

Added after the initial pivot, from user-provided context that sharpened the
target population and caught a real design flaw before it shipped further.

**Who this is for:** people who can hear and understand fine, and can move
and type fine, but can't reliably produce speech live, in the moment — severe
stutter, apraxia, ALS/motor neuron disease, post-stroke aphasia, non-verbal
autism, selective mutism. Not typing-impaired — typing is often their
*strongest* channel. It's live spoken conversation specifically that's
unreliable.

**Why this isn't "a faster AAC app."** Type-a-sentence-and-speak-it AAC apps
already exist (Proloquo2Go, Speech Assistant AAC, etc.) and are old,
insufficient tech for exactly the reason this mode exists: real conversation
is dynamic. A follow-up question means stopping, typing a whole new sentence,
and making everyone wait — exhausting, and why people avoid live conversation
when they can. This mode's actual differentiator is carrying the live
back-and-forth itself: the model responds to whatever the other person says
in real time, the way a human companion speaking on someone's behalf would.
The user only steps back in for a decision only they can make.

**The wrong assumption this corrected:** the initial build of this mode's
prompt (`domain/inPersonBrief.ts`) and iOS client
(`RealtimeSessionClient.swift`) said the user could interrupt or correct the
AI by just speaking up — "they can jump in themselves at any point... follow
them." That's backwards for exactly the population this mode is for.
Unreliable live speech production is the entire reason they're using it;
"just talk over it" is not an available fallback for a large share of the
intended users.

**The fix, in both places:**

- The prompt no longer expects or waits for spoken interruption. It's told
  explicitly not to treat silence as agreement or disagreement, and that the
  user reaches it a different way.
- The iOS client gained a real non-verbal interrupt path:
  `stopSpeaking()` sends `response.cancel` over the already-open `oai-events`
  data channel — one tap, no typing, stops the AI immediately. `BriefView`
  makes this the single largest, most prominent control on screen during a
  live session, not a secondary option.
- For a specific correction (not just "stop"), `sendCorrection(_:from:)`
  injects a typed message via `conversation.item.create` + `response.create`.
  It can't be sent as a plain `user`-role message, because OpenAI Realtime has
  no separate channel distinguishing "the person this AI represents" from
  "whoever is talking into the shared mic" — both arrive as the same `user`
  role (the same fundamental single-audio-stream constraint documented for
  phone mode in ADR-001/ADR-004, recurring here in a new shape). So the
  correction is wrapped in an explicit marker —
  `[TYPED CORRECTION FROM <name> — NOT SPOKEN BY THE OTHER PERSON]: <text>` —
  and the prompt is taught that exact format, told to treat it with full
  authority, and told never to read the marker itself out loud. The wording
  is kept in sync between `inPersonBrief.ts`'s `CORRECTION_MARKER_PREFIX` /
  `CORRECTION_MARKER_SUFFIX` constants and the Swift-side implementation by
  convention (documented in both places), not shared code — one side is
  TypeScript, the other Swift.
- The prompt also now says explicitly that being cut off mid-sentence is
  normal and expected, not an error, so the model doesn't get confused or
  start apologising when `response.cancel` lands.

**Also tightened:** the "sound natural, not robotic" requirement wasn't
previously spelled out. The prompt now explicitly tells the model to sound
like a confident person handling their own business — not a disclaimer, not
tentative, not hedged — because it's standing in as someone's only voice in
the exchange, and a hedged, mumbled delivery doesn't get taken seriously by
the other person.

**Flagged, not addressed:** phone mode has a real safety-category screening
layer (`domain/safety.ts` — domestic violence, minors, debt collection, legal
counterparties) built specifically for the risk profile of *that* mode:
delegating a hard conversation with someone the user has an existing, often
fraught, relationship with. In-person mode's typical use case (a counter, a
till, a reception desk) is a different risk surface, but nothing stops it
being pointed at a higher-stakes interaction. No equivalent screening exists
for this mode yet. Not built here — scope note only, so it isn't silently
assumed handled.

### Amendment — a browser test client, to verify before the iOS build exists

Added when the user asked how to test in-person mode without first shipping
an iOS build through Xcode and the App Store — a real problem, since the
iOS client needs a third-party WebRTC package (`stasel/WebRTC`, Apple ships
no first-party one) that had never been added or compiled in this project.

This turned out to be the right move independent of convenience: browser
WebRTC to OpenAI's Realtime API is the *first-class*, best-documented client
path — every browser ships WebRTC natively, whereas iOS needs an added
dependency precisely because Apple doesn't. A web client needs zero new
runtime dependencies and can be served from the Worker that's already live.
More importantly, it's the first thing in this project to exercise the real
mint → WebRTC → live-audio path at all — every backend test up to this point
fakes the OpenAI call at the `fetch` boundary.

**What it is:** `GET /web` (`backend/src/routes/web.ts`), a single Hono
route returning a self-contained HTML page (inline CSS + `<script
type="module">`, no build step, no framework) rather than a Workers Static
Assets binding — there was no prior art for that in this repo (no
`[assets]`/`[site]` block, no frontend build tooling anywhere), so an inline
route matching the existing `app.get('/health', ...)` shape was the smaller
addition. It implements the *identical* protocol
`RealtimeSessionClient.swift` does: no ICE servers (OpenAI's endpoint is a
direct SDP exchange, not third-party NAT traversal), data channel
`"oai-events"` created before the offer so it lands in the SDP, `POST
https://api.openai.com/v1/realtime/calls` with the ephemeral client secret,
the same Stop (`response.cancel`) and typed-correction
(`conversation.item.create` + `response.create`) controls as `BriefView`.
`/web` and `/realtime/session` are both unauthenticated today — anyone with
the URL can mint sessions against the account's OpenAI billing. That's
already true of hitting `/realtime/session` directly; the HTML wrapper
doesn't add a new privilege, but it's worth knowing before treating this as
more than an internal tool.

**Closing a drift risk this exposed:** the correction marker
(`[TYPED CORRECTION FROM <name> — NOT SPOKEN BY THE OTHER PERSON]: <text>`)
was, before this, duplicated by convention only — a source-of-truth pair of
constants in `domain/inPersonBrief.ts`, and a hardcoded copy in
`RealtimeSessionClient.swift`. A third hardcoded copy in the browser client
would have made drift a when-not-if. Fixed by adding
`correctionMarker: { prefix, suffix }` to `/realtime/session`'s response
body, sourced directly from the existing constants — non-breaking, since
Swift's `Decodable` on a struct without that field just ignores it. The
browser client reads the marker from the API response instead of hardcoding
it, so it structurally cannot drift; `backend/test/web.test.ts` asserts the
served page never contains the literal marker strings, specifically to keep
this property from regressing. (iOS could later be switched to the same
pattern — a natural follow-up, not done in this pass, since the task wasn't
to touch the iOS contract.)

**Verification, and its honest limits:** a Playwright script
(`e2e/run.mjs`, see `e2e/README.md`) drives this page in headless Chromium
with fake media devices against the live Worker and real OpenAI, and reports
six checkpoints individually rather than one pass/fail boolean. This
project's own sandbox was empirically confirmed, while planning this, to
have working HTTPS egress but no outbound UDP (a STUN request and an NTP
query both timed out; the equivalent HTTPS call didn't). WebRTC's actual
media and the `oai-events` data channel ride on UDP, so from an environment
like that, only the mint-session and SDP-offer/answer HTTPS legs are
provable — ICE connecting, the data channel opening, and real audio are not.
That split is real and is reported as such, not glossed over: a clean run
here proves the backend contract; it doesn't prove the live conversation
works. Only a human opening `/web` on their own device and network — hearing
the AI talk, tapping Stop mid-sentence, sending a correction — proves that.
This is the same fundamental limit phone mode already had (a human on a real
call was always the actual test); this just makes explicit which parts a
script can and can't stand in for.

**Recommendation:** keep `/web` as an internal engineering tool (it's cheap
— one route, one HTML string, one test file), not a second marketed product
surface. Its job is narrowing what's still unproven before the iOS build: a
clean pass here isolates "does OpenAI Realtime + WebRTC work at all" from
"does `stasel/WebRTC`'s specific Swift API integrate correctly" — only the
latter is still open afterward.

[rtwebrtc]: https://developers.openai.com/api/docs/guides/realtime-webrtc

---

## Incidental decisions

- **Node over Python** for the backend. The brief left it TBD. Node, because the
  MCP TypeScript SDK is the better-maintained one and it lets the intent schema
  (zod) be shared between the webhook handler, the MCP tool definitions, and the
  Vapi assistant config with no duplication.
- **`marin`** as the default voice, `cedar` available. Marin's clarity suits
  structured communication, which is what the delegate is doing; cedar's warmth
  may suit the interview better. Both are realtime-exclusive. Configurable in
  `backend/src/assistants/shared.ts` — this is a product-tuning knob, not a
  compliance one.

[cc]: https://docs.vapi.ai/calls/call-features
[awt]: https://docs.vapi.ai/calls/assistant-based-warm-transfer
[twilio]: https://docs.vapi.ai/calls/call-handling-with-vapi-and-twilio
[handoff]: https://docs.vapi.ai/squads/handoff
[analysis]: https://docs.vapi.ai/assistants/call-analysis
