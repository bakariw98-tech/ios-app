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
