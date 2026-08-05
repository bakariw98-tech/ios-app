# Conversation delegation app

An assistant that helps you say what's hard to say.

You call in. It interviews you about the situation — what happened, what you want
said, what must not be said. When you're ready you merge the other person into
the same call, and it speaks for you, staying inside the boundaries you set.
Afterwards you get a summary of how it went.

## Read these first

| | |
| --- | --- |
| [`docs/SETUP.md`](docs/SETUP.md) | Where the Vapi keys go and how to make the first call. |
| [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md) | Scope and locked decisions. |
| [`docs/compliance.md`](docs/compliance.md) | Why the flow is shaped this way, and the six rules enforced in code. |
| [`docs/technical-decisions.md`](docs/technical-decisions.md) | ADRs answering the open Vapi questions. |

**Before changing the call flow, read `docs/compliance.md`.** The AI's
self-introduction is not a UX string — it's the mechanism the whole product rests
on, and it is deliberately built so no prompt can skip it.

## Layout

```
backend/   Node + TypeScript. Vapi assistants, webhooks, MCP connector.
ios/       SwiftUI sources. No Xcode project yet — see ios/README.md.
docs/      Brief, compliance reasoning, ADRs.
```

## Backend

```bash
cd backend
npm install
cp .env.example .env      # fill in Vapi credentials — see docs/SETUP.md
npm run dev               # http://localhost:3000
npm test                  # 53 tests, including the compliance suite
```

`npm test` includes `test/lifecycle.test.ts`, which drives a whole call through
the real webhook — interview, arming, the recipient arriving, handoff, end-of-call
— with Vapi faked at the `fetch` boundary. The safety guards in it are
mutation-tested; see the commit history for the five mutations they catch.

The MCP connector runs separately over stdio:

```bash
npm run mcp
```

It exposes `start_interview`, `get_call_status`, `get_summary` — and
deliberately no `place_call`. Placing a call is always a human action.

## Where this is up to

**Done:** the three open technical questions are answered (ADR-001 to ADR-003).
Backend domain layer, both Vapi assistant configs, webhook handler, MCP
connector, and 22 passing tests including the compliance assertions.

**Not done:**

- **Nothing has run against real Vapi.** Every assistant config here is written
  from documentation, not from a call that happened. The lifecycle harness fakes
  Vapi at the `fetch` boundary, so it proves our state machine is coherent — not
  that our idea of Vapi's payloads is right. Expect the first live call to
  surface shape mismatches.
- **The iOS app has not been compiled** — no Swift toolchain where it was
  written. It also can't yet learn a call id, so the transcript and summary
  screens aren't reachable. See [`ios/README.md`](ios/README.md).
- **Storage is in-memory.** Fine for a pilot on one instance, not for two.
- **The merge step is unvalidated on real carriers.** This is the largest
  delivery risk in v1 — see ADR-001.

## Next

1. Stand up a Vapi number and run one real call end to end. That will teach us
   more than the next 500 lines of code.
2. Build the carrier device matrix for three-way merge.
3. Solve call-id association so the app can follow a live call (options in
   `ios/README.md`).
4. Swap the in-memory store for Postgres.
5. Engage counsel before opening this past a small pilot.
