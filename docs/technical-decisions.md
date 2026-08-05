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
  the user's behalf. The app can only *instruct*. The UI must teach this step
  well, because it is the moment the product succeeds or fails.
- **Not programmatically detectable.** The app cannot observe the merge. So the
  handoff must be triggered another way — see ADR-002.
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

Since the merge is undetectable (ADR-001), the handoff is triggered by the user
saying an agreed phrase ("they're on the line" / "okay, they're here"), which the
interview assistant is prompted to recognize. The backend independently arms a
disclosure backstop over the control URL so that even a mistimed handoff cannot
result in the recipient hearing the AI speak before the disclosure.

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
