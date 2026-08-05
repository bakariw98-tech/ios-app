# AI Conversation Delegation App — Project Brief

> Canonical source of truth for scope and locked decisions.
> Changes to the "Core call flow" or "Compliance non-negotiables" sections require
> re-checking the legal reasoning in [`compliance.md`](./compliance.md) first.

## What this is

An iOS app that helps someone say the things they find difficult to say. The user
calls in, an AI interviews them to understand the situation, then the user brings
the recipient into the same call — the AI speaks on the user's behalf, in real
time, staying within boundaries the user set.

Framed to users as: **"an assistant that helps you say what's hard to say."**
Never marketed or described as "a phone agent that calls people for you."

## Core call flow (locked in)

1. User opens the app, taps a button, and **dials the number themselves**. No
   autodialing, no server-initiated outbound call to the recipient — ever.
2. The AI interviews the user by voice: what happened, how they feel, what they
   want communicated, what outcome they want, any boundaries (must-say /
   never-say).
3. The AI produces an internal **intent object** from the interview.
4. The user **adds/merges the recipient into the same call**.
5. The moment the AI is on the line with the recipient, its first words — every
   single call, no exceptions, not user-configurable — are a self-identification:
   > "Hi, I'm an AI assistant calling on behalf of [user] — they wanted to talk to
   > you but asked me to help say this. Do you want to continue?"

   It waits for a yes before proceeding.
6. The AI conducts the conversation naturally, adapting, staying within the
   user's stated boundaries.
7. The AI ends the call naturally.
8. The user receives a text/summary: what was discussed, what was answered, and
   whether the goal was achieved.

## Product principles

- The AI represents the user **faithfully** — it does not improvise outside the
  user's stated intent and boundaries.
- The AI **always discloses that it is an AI**, every call, at first contact with
  the recipient.
- The user is **never impersonated as human**.
- Hard-block categories, with refusals designed before launch:
  - domestic violence situations
  - contact with minors
  - debt collection
  - anything with a legal counterparty on the other end

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| iOS frontend | SwiftUI | Chat box + a visible phone number / call button. Design may come from Claude Design or Lovable first, then implemented natively — TBD. |
| Backend | Node + TypeScript | Independent of iOS; call handling must run server-side regardless of client. (Python was the alternative; Node chosen — see [ADR](./technical-decisions.md).) |
| Voice AI | Vapi wrapping OpenAI Realtime | Model `gpt-realtime-2025-08-28` (production). Voice `marin` or `cedar`. |
| MCP connector | `start_interview`, `get_call_status`, `get_summary` | Deliberately **no** `place_call` tool. |
| Apple Intelligence | Optional / secondary | Foundation Models (on-device, ~3B) could handle the interview privately and cheaply, but Realtime can do it directly. Not a v1 blocker. |

### Voice selection constraint

`marin` and `cedar` are the two realtime-exclusive, higher-quality voices. Do not
use `alloy`/`echo`/`shimmer` (supported but lower quality), and note that
`ash`, `ballad`, `coral`, `fable`, `onyx`, and `nova` are **not supported by
realtime models at all**.

### Why Vapi over raw OpenAI Realtime + Twilio

Vapi handles the phone number, call bridging, and Realtime session orchestration.
Chosen for v1 to move faster. Can be swapped for a self-hosted Twilio + raw
Realtime setup later, once the product is validated, for full control over
interruption/endpointing behavior and no middleman cost.

## Explicitly out of scope for v1

- **Server-initiated outbound calling.** Requires prior consent obtained *before*
  the call is placed (e.g. a consent text with a link the recipient taps first) —
  a different, heavier flow. Revisit only if a fully-autonomous "AI just calls
  them" mode becomes a priority.
- **B2B calling** (dealerships, banks, etc.). Different legal category, and a weak
  value proposition when the user could just call themselves.

## Status of the open technical questions

The three questions carried into this session are answered in
[`technical-decisions.md`](./technical-decisions.md):

1. Does Vapi support add-participant cleanly? — **No.** See ADR-001.
2. One continuous session, or a handoff between two assistant configs? — **One
   call, two assistants via the handoff tool.** See ADR-002.
3. Webhook design for post-call summary generation. — See ADR-003.
