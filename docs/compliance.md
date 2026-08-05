# Compliance reasoning and non-negotiables

> This document exists so that the *reasoning* survives, not just the rules. If a
> future feature request conflicts with something here, the conflict must be
> resolved by re-reading the reasoning — not by quietly relaxing the rule.
>
> **This is engineering documentation of a product decision, not legal advice.**
> Engage counsel before scaling past a small number of active users/calls. The
> reasoning below is sound for early, manual-scale use; it is not guaranteed to
> hold at real product volume.

## Why the call flow is shaped the way it is

TCPA covers AI/artificial-voice calls to wireless numbers absent prior consent,
and it has real teeth: **$500–$1,500 per call, a private right of action, and no
cap.**

The specific conduct regulators and plaintiffs have actually gone after is
**automated, bulk, one-to-many outbound dialing** — soundboard telemarketing
floors, mass robocall campaigns. Not a single user manually dialing one contact
they already know.

So the defensible position, without adding friction like a pre-call consent
text/link, is the conjunction of all of these:

- the call is **user-initiated**,
- there is **no autodialer**,
- it goes to **one known contact**,
- the AI **self-identifies** and **obtains verbal consent** before proceeding.

### Two arguments that must never appear in the product or in comms

1. **"It's personal, not sales."** Non-marketing AI voice calls are still fully
   covered by TCPA. This is not a defense and must not be relied on anywhere —
   not in the app, not in marketing, not in internal justification.
2. **"The AI is basically the user."** The user is never impersonated as human.
   That is a product principle *and* the thing that makes disclosure coherent.

The protection here is about **scale and manual initiation**, not about the
content category of the call.

## Non-negotiables (enforced in code)

| # | Rule | Where it is enforced |
| --- | --- | --- |
| N1 | The AI's first words to the recipient are the self-identification disclosure. Every call. No exceptions. | `backend/src/assistants/delegate.ts` — `firstMessage` + `firstMessageMode: "assistant-speaks-first"`, plus a server-side `say` injection as backstop. |
| N2 | The disclosure is not user-configurable, not skippable, not shortenable. | `backend/src/domain/disclosure.ts` — single frozen constant, asserted by tests. No API surface accepts an override. |
| N3 | The AI waits for affirmative consent before delivering the user's message. | Delegate assistant prompt + `consentObtained` gate in the intent state machine. |
| N4 | No server-initiated outbound call to the recipient. | No outbound-call code path exists. The MCP connector deliberately omits `place_call`. |
| N5 | The AI never claims to be human, even if asked to. | Delegate prompt hard rule + refusal handling. |
| N6 | Hard-blocked categories are refused before a call can start. | `backend/src/domain/safety.ts`, checked during the interview and again before handoff. |
| N7 | Nothing from the interview is spoken once the merge has begun, because the recipient may already be listening. | `backend/src/domain/mergeWindow.ts` — quiet mode from `arm_for_merge` until handoff, with a server-side tripwire. |

### N2 in particular

The self-ID + verbal consent step is **not a UX nicety — it is the product's
actual compliance mechanism.** It will feel awkward. Users will ask for it to be
shorter, softer, or optional. The answer is no, and the reason is this file.

Because an LLM can be talked out of following its own prompt, N1/N2 are
implemented so the disclosure is **not the model's decision**:

- It is the delegate assistant's `firstMessage`, spoken before the model gets a
  turn (`firstMessageMode: "assistant-speaks-first"`).
- The backend independently injects it over the live-call control URL if the
  handoff completes without it having been spoken.

## Hard-block categories

Refusals are designed for these before launch. Screening runs during the
interview, and again immediately before the recipient is brought on:

- **Domestic violence situations** — delegating contact can escalate danger and
  can interfere with protective orders.
- **Contact with minors** — no adult-to-minor delegated contact.
- **Debt collection** — FDCPA territory, plus TCPA exposure that this flow's
  reasoning does not cover.
- **Any legal counterparty** — opposing parties, opposing counsel, anyone the
  user is in a dispute or proceeding with.

Refusals are delivered warmly and point to a human alternative. See
`backend/src/domain/safety.ts`.

## Revisit triggers

Re-engage counsel and re-read this document if any of the following becomes true:

- Active users or call volume grows beyond a small pilot.
- Anyone proposes a server-initiated outbound mode.
- Anyone proposes B2B / business-line calling.
- Anyone proposes making the disclosure shorter, conditional, or optional.
- Recipients begin receiving calls from users who do not personally know them.
