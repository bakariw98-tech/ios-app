/**
 * The typed intake step — asks the user a few short follow-up questions
 * before the live in-person session starts, then hands off one enriched
 * paragraph to the existing, unchanged brief pipeline.
 *
 * ## Why this exists
 *
 * Live beta feedback: the delegate model (`inPersonBrief.ts`) works
 * exceptionally well once it has enough context, but a single one-shot
 * free-text box often doesn't give it enough — real requests need specifics
 * (order details, names, amounts, what "done" looks like) that people don't
 * always think to type unprompted. This module exists to draw those out with
 * a few short questions before the live session starts, so the model isn't
 * improvising on a thin brief.
 *
 * ## Why typed, never spoken
 *
 * This is the same population `inPersonBrief.ts` is written for — people who
 * can hear, understand, move, and type fine, but can't reliably produce live
 * speech in the moment. Unreliable live speech production is the entire
 * reason this mode exists; a spoken intake step would reintroduce the exact
 * wrong assumption ADR-005's first amendment already corrected once (see
 * `docs/technical-decisions.md`). This intake is a typed chat, full stop.
 *
 * ## Why one paragraph, not structured fields
 *
 * Phone mode's `intent.ts` has a much richer structured shape
 * (recipientName, pointsToConvey, mustSay, neverSay, tone, ...), populated by
 * Vapi's `variableExtractionPlan` running against a live call transcript
 * inside a Vapi `handoff` — a Vapi-platform mechanism with no equivalent in
 * this mode's direct-OpenAI-Realtime-over-WebRTC path. That machinery is not
 * reusable here, only its general shape as a design reference. Deliberately
 * NOT rebuilt: this module's whole output is one enriched string that slots
 * into the EXISTING `BriefSchema.situation` field unchanged, so the
 * already-verified-live delegate pipeline (`inPersonBrief.ts`, `realtime.ts`,
 * `openaiRealtime.ts`) needs no changes at all. Structured fields would
 * re-touch that pipeline for no real gain — the delegate only ever consumes
 * prose — and a form is exactly the high-effort shape this population is
 * fatigued by (see `inPersonBrief.ts`'s "who this is for").
 *
 * ## Why the model never learns the correction marker
 *
 * This intake LLM is not the delegate. It never sees
 * `CORRECTION_MARKER_PREFIX`/`SUFFIX` and is never taught the format — if it
 * were, and it ever echoed bracket-shaped text back, the delegate could
 * mistake it for an authoritative correction. Keeping the marker's blast
 * radius at exactly two places (the delegate prompt, the client) is
 * deliberate. See `test/inPersonIntake.test.ts`'s marker-containment guard.
 */

import { z } from 'zod';

/** Matches BriefSchema.situation's bounds exactly — see the note on IntakeRequestSchema. */
const SITUATION_MAX = 4000;

/**
 * Soft cap the prompt is told to self-impose; the route enforces this as a
 * hard cap regardless of what the model does (see composeTranscriptSituation
 * and the finalize-nudge in routes/intake.ts). Every extra question is a
 * real cost to this population, not a mild inconvenience — keep this low.
 */
export const MAX_INTAKE_QUESTIONS = 4;

/** Q+A pairs, so the array-length cost guard tracks the question cap directly. */
export const MAX_INTAKE_TURNS = MAX_INTAKE_QUESTIONS * 2;

export const IntakeTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(SITUATION_MAX),
});
export type IntakeTurn = z.infer<typeof IntakeTurnSchema>;

export const IntakeRequestSchema = z.object({
  /**
   * The user's original, unedited first message — same bounds as
   * `BriefSchema.situation` (backend/src/domain/inPersonBrief.ts). This
   * bound-matching is load-bearing, not incidental: whatever this module
   * eventually produces must always be accepted by BriefSchema downstream,
   * and keeping the same ceiling here is what makes that true by
   * construction rather than by hoping composeTranscriptSituation's clamp
   * never needs to do real work.
   */
  situation: z.string().min(1).max(SITUATION_MAX),
  userFirstName: z.string().max(100).optional(),
  /** The conversation so far, oldest first. Empty on the very first turn. */
  turns: z.array(IntakeTurnSchema).max(MAX_INTAKE_TURNS).default([]),
});
export type IntakeRequest = z.infer<typeof IntakeRequestSchema>;

/**
 * The Structured Outputs contract for the intake model's reply.
 *
 * Uses `.nullable()`, not `.optional()`, throughout. OpenAI's
 * `strict: true` json_schema mode requires every property in `properties`
 * to also appear in `required`, with `additionalProperties: false` — an
 * "optional" field under strict mode is expressed by making it nullable,
 * not by omitting it. This is the single most likely thing to get "cleaned
 * up" into a 400 by someone who hasn't hit this before — see
 * lib/openaiChat.ts's doc comment and the JSON-schema drift guard test.
 */
export const IntakeReplySchema = z.object({
  done: z.boolean(),
  /** Non-null iff done is false. */
  question: z.string().nullable(),
  /** Non-null iff done is true. */
  situation: z.string().nullable(),
});
export type IntakeReply = z.infer<typeof IntakeReplySchema>;

/**
 * Hand-written, not derived via `z.toJSONSchema` (unlike intent.ts's
 * intentJsonSchema — that targets Vapi, which is lenient about schema shape;
 * OpenAI's strict Structured Outputs mode has requirements (additionalProperties:
 * false, every property in required) zod's emitter doesn't guarantee it hits).
 * Kept in sync with IntakeReplySchema by a drift-guard test, not by
 * generation, so a future edit to one is caught if the other isn't updated
 * too.
 */
export const INTAKE_REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    question: { type: ['string', 'null'] },
    situation: { type: ['string', 'null'] },
  },
  required: ['done', 'question', 'situation'],
  additionalProperties: false,
} as const;

export type NormalizedIntakeReply =
  | { kind: 'question'; question: string }
  | { kind: 'done'; situation: string };

/**
 * Rejects the two incoherent combinations (done:true with situation:null;
 * done:false with question:null) so routes/intake.ts never has to reason
 * about them — a malformed reply becomes a thrown error, handled the same
 * way an unparseable one is.
 */
export function normalizeIntakeReply(reply: IntakeReply): NormalizedIntakeReply {
  if (reply.done) {
    if (!reply.situation) {
      throw new Error('intake model said done but returned no situation');
    }
    return { kind: 'done', situation: reply.situation };
  }
  if (!reply.question) {
    throw new Error('intake model said not done but returned no question');
  }
  return { kind: 'question', question: reply.question };
}

/**
 * The deterministic, no-LLM roll-up of the conversation so far. This is what
 * Skip sends (client-side, mirroring this exact logic — see
 * routes/web.ts's `situationSoFar`), and what the route falls back to if the
 * model still won't finalize at the question cap. Always non-empty, always
 * ≤ SITUATION_MAX, always a plain paragraph BriefSchema will accept.
 */
export function composeTranscriptSituation(request: {
  situation: string;
  turns: IntakeTurn[];
}): string {
  const parts = [request.situation.trim()];
  for (const turn of request.turns) {
    if (turn.role === 'assistant') {
      parts.push(`Asked: ${turn.text.trim()}`);
    } else {
      parts.push(`Answered: ${turn.text.trim()}`);
    }
  }
  return clampSituation(parts.join('\n'));
}

/** Trim + clamp to SITUATION_MAX so nothing this module produces can ever fail BriefSchema. */
export function clampSituation(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SITUATION_MAX ? trimmed.slice(0, SITUATION_MAX) : trimmed;
}

/**
 * The intake model's system prompt.
 *
 * Candidate follow-up topics below are borrowed as PROSE from intent.ts's
 * field list (desired outcome, specifics, must-say, don't-say) — a topic
 * borrowing, explicitly not shared code or a shared schema. See this file's
 * top doc comment for why the two can't mechanically share more than that.
 */
export function buildIntakeInstructions(opts: { userFirstName?: string }): string {
  const addressAs = opts.userFirstName?.trim() || 'the user';

  return `
You are helping ${addressAs} prepare for a conversation they're about to have
out loud, in person, right now — a separate AI will speak on their behalf
once this is done. ${addressAs} is TYPING to you, not speaking; they may not
be able to reliably produce speech at all, which is the whole reason this app
exists. Everything you say is read on a screen, never heard.

## Your only job

Ask short, concrete follow-up questions — one at a time — until you could
write a paragraph a stranger could act on immediately. Then stop and produce
that paragraph.

## Think before you ask

In a few minutes, ${addressAs}'s exact words are going to come out of a
different AI's mouth, live, to whoever is standing in front of them. Before
your first question, put yourself there: you're the one about to open your
mouth and speak for them. What would you actually need to know to do that
well? Not what would look thorough on a form — what would you, standing
there, genuinely be missing?

Work out — in your own reasoning, not something you say out loud — what
${addressAs} is actually trying to achieve. Not just what they said they
want conveyed, but the real goal underneath it: what would count as this
working? What do they want to walk away with?

Every question you ask has to exist for one of two reasons: it helps you
understand that goal more precisely, or it helps you figure out what stands
between the situation as described and actually reaching it. If a question
doesn't serve one of those, don't ask it — walking a topic checklist
mechanically is not the same as understanding what someone needs, and it
produces exactly the wrong kind of question: something that would help fill
out a form, not something that would help you speak.

**Never ask about administrative or identifying details that don't change
what actually gets said out loud** — which specific branch or location,
an address, a phone number, an account number nobody's mentioned. A person
who's about to speak for someone doesn't need to know which store this is;
they need to know what to say once they're speaking. If information like
that genuinely matters (an order number to look up, an account to
reference), ask about that specific thing directly — never about the
location or identity of who they're speaking to as a category.

Concretely, that usually means asking in roughly this order, skipping
whatever's already answered by what they typed:
1. If the goal itself isn't clear yet, that's your first question — not a
   detail. ("What are you hoping to walk away with?" / "What would count as
   this working out?")
2. Once you know the goal, ask about whatever specifically stands between
   here and reaching it — a constraint, a likely complication, something the
   other person will probably ask about. (Someone wanting a $100-off
   promotion applied isn't really asking you to "mention the promotion" —
   their goal is getting the discount, so the useful question is whether
   they have another discount that might conflict with it, not a generic
   "anything else?")
3. Only once the goal and the real obstacles are covered, round out with
   whatever concrete specifics make it land and are actually going to be
   spoken out loud: order details, amounts, dates, names, reference numbers
   — never logistics like which location or how to get there, which a
   person actually standing there wouldn't need to ask.
4. Anything they want said close to word-for-word, or specifically avoided.

## Rules

- Exactly ONE question per turn. Never a list of questions.
- Never ask about anything already stated or clearly implied by what they
  typed — re-asking a covered topic is a real cost to this person, not a
  mild inconvenience.
- Never ask them to re-type or repeat something they already gave you.
- Stop as soon as you have enough, or after ${MAX_INTAKE_QUESTIONS} questions
  total, or the instant they signal they're done ("that's it", "just go",
  "start now") — whichever comes first. Fewer questions is always better than
  more, if you already have enough to work with.
- Never mention this app's live-session mechanics, correction protocol, or
  anything about how the delegate AI will behave once it's speaking — that's
  a separate, later step you have no part in.

## When you finalize

Set done to true and write ONE plain paragraph in the "situation" field:
- State the goal plainly, not just the surface request — what the person
  actually wants to walk away with, so the delegate AI speaking on their
  behalf knows what it's working toward, not only what to mention.
- A description of the situation for another AI to act on — never a script
  to read aloud, never instructions addressed to an assistant, never
  dialogue, never a bracketed list.
- Contains only facts ${addressAs} actually gave you across this
  conversation. Never invent details, names, prices, or facts nobody stated.
- Preserves ${addressAs}'s own wording for anything they said they want said
  close to verbatim.
- No meta-commentary, no labels, no stage directions — just the paragraph.
`.trim();
}

/**
 * Assembles the message array sent to the intake model: system prompt, then
 * the user's original situation as the first user message, then the turns
 * in order. Kept separate from the route so it's unit-testable without a
 * fetch mock — see test/inPersonIntake.test.ts.
 */
export function buildIntakeMessages(
  request: IntakeRequest,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildIntakeInstructions({ userFirstName: request.userFirstName }) },
    { role: 'user', content: request.situation },
  ];
  for (const turn of request.turns) {
    messages.push({ role: turn.role, content: turn.text });
  }
  return messages;
}

/**
 * Appended as a final system message once the question cap is reached, so
 * the model is told plainly rather than left to infer it from turn count.
 * The route enforces the cap regardless of whether the model complies (see
 * routes/intake.ts) — this message is what makes non-compliance the
 * exception rather than the norm.
 */
export function buildFinalizeNudgeMessage(): { role: 'system'; content: string } {
  return {
    role: 'system',
    content:
      `You have used your last question. Reply now with done: true and the ` +
      `situation paragraph, using whatever you've learned so far — do not ` +
      `ask another question.`,
  };
}
