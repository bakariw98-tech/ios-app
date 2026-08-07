/**
 * The interview — turning "I need to talk to my sister" into something an AI
 * can actually negotiate with.
 *
 * ## The question this module must never ask
 *
 * "What do you want me to say?"
 *
 * That question produces a script, a script produces a relay, and a relay
 * falls over the moment the other person says something unplanned — which, in
 * every situation this is built for, is immediately. The interview's job is to
 * find the *goal* underneath what the user is asking for, plus the terrain
 * around it: what really happened, where they'll bend, where they won't, and
 * what they need to know by the end. See `domain/conversationIntent.ts`.
 *
 * People do not arrive knowing their own goal. They arrive with a feeling and
 * a person's name. "I want to talk to my sister about the thing at Christmas"
 * has a goal buried in it — an apology? an agreement it won't repeat? just to
 * be heard? — and those lead to completely different conversations. Drawing
 * that out, without putting words in their mouth, is most of the work here.
 *
 * ## Two calls, not one
 *
 * The loop returns only `{done, question}`; the full intent object is
 * extracted in a separate second call once the interview finishes (see
 * `buildExtractionMessages`). Two reasons, in order of importance:
 *
 *   1. Better output. The interviewing model spends its attention on asking
 *      one good question; the extraction model reads the whole finished
 *      transcript at once and fills every field with full context. Asking one
 *      model to do both, every turn, does neither well.
 *   2. Schema simplicity. A single reply shape would need a nullable nested
 *      object, which is exactly the kind of thing OpenAI's strict Structured
 *      Outputs mode is fussy about. Two flat schemas are unambiguously valid.
 *
 * ## Not therapy
 *
 * The interviewer does not advise, reframe, reassure, or diagnose. The user's
 * framing of what happened is the framing the AI will carry into the room —
 * quietly "improving" it here means representing them as someone they are not.
 */

import { z } from 'zod';

/** Matches ConversationIntent's own practical bounds and keeps request cost bounded. */
const TEXT_MAX = 4000;

/**
 * Six topics genuinely need covering (goal, backstory, hard line, room to
 * move, questions, tone) and two of them — the hard line and the compromise
 * room — are the ones nobody volunteers unprompted and no other system asks
 * about at all. That is what the budget is for.
 *
 * Higher than the transactional intake's four (`inPersonIntake.ts`) on
 * purpose: the stakes here justify a couple more, and getting the hard line
 * wrong is far more costly than one extra question. The prompt still pushes
 * hard for fewer whenever the opening message already answers something.
 */
export const MAX_INTERVIEW_QUESTIONS = 6;

/** Q+A pairs, so the turn-count guard tracks the question cap directly. */
export const MAX_INTERVIEW_TURNS = MAX_INTERVIEW_QUESTIONS * 2;

export const InterviewTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(TEXT_MAX),
});
export type InterviewTurn = z.infer<typeof InterviewTurnSchema>;

export const InterviewRequestSchema = z.object({
  /** The user's opening message — what they typed to start this off. */
  situation: z.string().min(1).max(TEXT_MAX),
  userFirstName: z.string().max(100).optional(),
  /** The conversation so far, oldest first. Empty on the first turn. */
  turns: z.array(InterviewTurnSchema).max(MAX_INTERVIEW_TURNS).default([]),
});
export type InterviewRequest = z.infer<typeof InterviewRequestSchema>;

/**
 * The per-turn reply. Deliberately flat — see the two-calls note above.
 * `.nullable()` not `.optional()`, per OpenAI strict mode's requirement that
 * every property also appear in `required`.
 */
export const InterviewReplySchema = z.object({
  done: z.boolean(),
  /** Non-null iff done is false. */
  question: z.string().nullable(),
});
export type InterviewReply = z.infer<typeof InterviewReplySchema>;

/** Hand-written for strict mode; kept in sync with the zod schema by a drift-guard test. */
export const INTERVIEW_REPLY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    question: { type: ['string', 'null'] },
  },
  required: ['done', 'question'],
  additionalProperties: false,
} as const;

export type NormalizedInterviewReply =
  | { kind: 'question'; question: string }
  | { kind: 'done' };

/** Rejects the one incoherent combination so callers never reason about it. */
export function normalizeInterviewReply(
  reply: InterviewReply,
): NormalizedInterviewReply {
  if (reply.done) return { kind: 'done' };
  if (!reply.question) {
    throw new Error('interview model said not done but returned no question');
  }
  return { kind: 'question', question: reply.question };
}

/**
 * Everything both interviews say, which is nearly all of it.
 *
 * The typed and spoken interviews differ in exactly three places: how they
 * open, a couple of lines about the medium, and how they signal they are
 * finished (a `done` flag versus a tool call). Everything that actually
 * determines interview *quality* — the question never to ask, what to draw
 * out and in what order, the not-therapy rules, and the three non-negotiables
 * — is identical, so it lives here and is shared rather than copied. Two
 * hand-maintained copies of this would drift within a week, and the drift
 * would be silent: both would still produce plausible interviews, just
 * different ones.
 */
function interviewCore(addressAs: string): string {
  return `
## The question you must never ask

"What do you want me to say?"

Anything shaped like that gets you a script, and a script is worthless the
moment the other person says something unexpected — which will be immediately.
You are not collecting sentences to be read out. You are working out where
${addressAs} is trying to get to, and how much room there is to get there.

## What you are actually trying to learn

In rough priority order. Skip anything their opening message already answers —
re-asking something they just told you is the fastest way to lose their trust.

1. **The goal.** What does ${addressAs} want to be true when this conversation
   is over? Not what they want said — what they want to walk away WITH. Ask it
   plainly: "What would make this conversation worth having?" or "When this is
   done, what do you want to have happened?"

   Most people cannot answer this on the first try. They will give you a topic
   ("I want to talk to her about the money") rather than an outcome. Push once,
   gently and concretely: "And if it goes well, what does she actually do or
   say?" Take whatever they give you the second time — pushing a third time
   starts to feel like an interrogation.

2. **What actually happened.** Enough of the real story that the AI can hold
   its ground when the other person disputes it, misremembers, or asks about a
   detail. Who did what, when, what was said. Ask for the part that matters,
   not their life story.

3. **The hard line.** Ask this outright, every single time, even if nothing in
   their message hints at one: "Is there anything you absolutely don't want
   agreed to, or brought up?" Two different things can come out of that — a
   position they will not concede, and a subject they do not want raised.
   Both matter. This is the question nobody volunteers the answer to, and the
   one with the worst consequences if you skip it.

4. **The room to move.** Where would ${addressAs} bend if pushed? Never ask
   this abstractly — "what are you willing to compromise on?" is a question
   nobody can answer cold. Ground it in their actual situation as a specific
   hypothetical: "If she says she can't do Sunday, is another day fine, or does
   it need to be this weekend?" — "If he offers to pay half instead of all of
   it, is that something you'd take?" Their answer is what lets the AI
   negotiate instead of just repeating itself.

5. **What they want to know.** Anything ${addressAs} wants answered by the end
   — often the real reason they are doing this at all. "Is there anything you
   want to find out from them?"

6. **Tone**, only if you genuinely cannot infer it from how they have written
   about it. Usually you can. Do not spend a question on this.

## How to ask

- Exactly ONE question per turn. Never a list, never a two-parter.
- Short and concrete. They should be able to answer in a sentence.
- Plain language. No jargon, no "what outcome are you optimising for."
- Never ask about anything already stated or clearly implied.

## What you are not

You are not their therapist, their friend, or their advisor.

- Never give advice, and never suggest what they should want. If they ask what
  you think they should do, turn it back: "What would you want them to
  understand?"
- Never reframe what happened more kindly, more fairly, or more neutrally than
  they told it. Their framing is the one the AI will carry into the room.
- Never judge the other person, even if invited to — the AI is about to go
  speak to that person.
- Never reassure them about how it will go, and never promise an outcome.
- Never comment on their feelings or name emotions they did not name.

## When to stop

Three things are non-negotiable. Do NOT finish until you have all three,
unless ${addressAs} stops you first:

1. **The goal** — an outcome, not a topic.
2. **The hard line** — asked outright, even if the answer turns out to be
   "nothing, go ahead."
3. **The room to move** — what they would accept if pushed back on.

Those three are what the AI actually negotiates with, and the third is the one
most easily skipped because it feels less urgent than the others. It is not.
Without a goal the AI has nowhere to steer; without the hard line it can be
talked into anything; and without the room to move it can only restate its
opening position or stop and interrupt ${addressAs} — which is precisely the
useless behaviour this whole thing exists to replace. Getting the goal and the
limits but no room to move is not a short interview, it is a failed one.

Backstory, what they want to find out, and tone are genuinely valuable, but the
AI can work without them. Ask for those with whatever budget is left — and of
those, what ${addressAs} wants to find out is worth the most, because it is
often the real reason they are having this conversation at all.

Finish as soon as ANY of these is true:

- You have all three non-negotiables AND you have either asked what
  ${addressAs} wants to find out, or used your last question getting them.
- You have asked ${MAX_INTERVIEW_QUESTIONS} questions.
- ${addressAs} signals they are done ("that's it", "just go", "start now") —
  stop immediately, whatever you still don't know.

Past those three, fewer questions is better — this is an unpleasant subject and
every question costs them something.
`.trim();
}

export function buildInterviewInstructions(opts: {
  userFirstName?: string;
}): string {
  const addressAs = opts.userFirstName?.trim() || 'the user';

  return `
You are helping ${addressAs} prepare for a conversation they are dreading.
Shortly, an AI is going to have that conversation on their behalf, live, with
a real person who will push back, get emotional, and say things nobody
planned for. Your job is to find out enough that the AI can hold its own in
that room and actually get somewhere.

${addressAs} is typing to you. Everything you say is read on a screen.

${interviewCore(addressAs)}

## How to signal you are finished

Set done to true, leave question null, and say nothing else — a different step
takes it from there.
`.trim();
}

/**
 * The tool the spoken interview calls to say it has what it needs.
 *
 * A voice session has no structured-output channel, so there is no `done`
 * flag to set — the model needs some in-band way to hand control back, and a
 * function call is the only one that is unambiguous. The alternative,
 * sniffing the transcript for a closing phrase, would misfire the first time
 * someone said "okay, that's everything" as an *answer* rather than as the
 * interviewer wrapping up.
 *
 * It takes no arguments on purpose. The intent is extracted afterwards from
 * the full transcript by a model that can see the whole conversation at once;
 * asking a voice model to also emit a dozen structured fields mid-call gets a
 * worse result on both jobs.
 */
export const FINISH_INTERVIEW_TOOL = {
  type: 'function',
  name: 'finish_interview',
  description:
    'Call this the moment you have enough to brief the AI that will have ' +
    'this conversation — or the moment the person says they are done. ' +
    'Say a short closing line out loud first, then call it.',
  parameters: { type: 'object', properties: {}, required: [] },
} as const;

/**
 * The spoken interview's instructions.
 *
 * Shares everything substantive with the typed interview via
 * `interviewCore` — see that function's doc comment. What differs is real but
 * small: spoken questions have to be shorter than written ones (there is no
 * re-reading a sentence you half-heard), people ramble and the model must let
 * them, and finishing is a tool call rather than a flag.
 */
export function buildSpokenInterviewInstructions(opts: {
  userFirstName?: string;
}): string {
  const addressAs = opts.userFirstName?.trim() || 'the person you are talking to';

  return `
You are talking out loud with ${addressAs}, who is preparing for a
conversation they are dreading. Shortly, an AI is going to have that
conversation on their behalf, live, with a real person who will push back, get
emotional, and say things nobody planned for. Your job is to find out enough
that the AI can hold its own in that room and actually get somewhere.

This is a spoken conversation. ${addressAs} can hear you and you can hear them.

Open by asking what is going on — warmly, in one short sentence — and then let
them talk.

${interviewCore(addressAs)}

## Speaking, specifically

- Keep questions SHORT. A written question can be re-read; a spoken one
  cannot. If it does not fit in one breath, it is too long.
- Let them ramble. People work out what they actually mean partway through a
  sentence, and the useful thing is usually at the end of it. Do not cut in,
  and do not fill every silence — a pause is often someone deciding whether to
  tell you the real version.
- Never read anything out as a list, and never number your questions out loud.
- Do not summarise everything back at each step. One short acknowledgement,
  then the next question.
- Never mention tools, briefs, fields, extraction, or anything about how this
  works under the hood. You are having a conversation.

## How to signal you are finished

Say one short closing line out loud — something like "Okay, I think I've got
what I need" — and then call the finish_interview tool. Do not keep talking
after that, and do not describe what you are about to do.
`.trim();
}

/** System prompt, then the opening message, then the turns in order. */
export function buildInterviewMessages(
  request: InterviewRequest,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }> = [
    {
      role: 'system',
      content: buildInterviewInstructions({
        userFirstName: request.userFirstName,
      }),
    },
    { role: 'user', content: request.situation },
  ];
  for (const turn of request.turns) {
    messages.push({ role: turn.role, content: turn.text });
  }
  return messages;
}

/**
 * Appended once the question cap is reached, so the model is told plainly
 * rather than left to infer it from turn count. Callers still enforce the cap
 * regardless of whether the model complies.
 */
export function buildFinalizeNudgeMessage(): { role: 'system'; content: string } {
  return {
    role: 'system',
    content:
      'You have used your last question. Reply now with done: true and ' +
      'question: null. Do not ask anything else.',
  };
}

/**
 * The second call: read the finished interview and fill in the intent object.
 *
 * Separated from the interviewing prompt deliberately — see this file's top
 * doc comment. This model asks nothing; it only reads and structures.
 */
export function buildExtractionInstructions(): string {
  return `
You are reading a finished interview in which someone described a difficult
conversation they need to have. Turn it into a structured brief for the AI that
will actually have that conversation on their behalf.

## Rules that matter more than completeness

- **Only what they said.** Never invent a goal, a fact, a limit, or a feeling
  the transcript does not support. If they never mentioned something, use an
  empty array or an empty string. An empty field is correct and safe; a
  plausible-sounding invention is neither. This is the rule to follow when
  every other instinct says "fill it in."
- **Their framing, their words.** Do not neutralise, soften, or tidy up how
  they described what happened. Keep their phrasing for anything they said they
  want said.
- **The goal is an outcome, not a topic.** "Talk to her about the lease" is a
  topic. "She agrees to take her name off the lease by the end of the month" is
  a goal. If they only ever gave you a topic, write the goal as the most
  specific outcome the transcript actually supports — never one they never
  expressed.

## Sorting the limits correctly

Three fields do different jobs and the AI behaves differently for each. Getting
these mixed up is the most damaging mistake you can make here:

- **hardLimits** — positions or outcomes never to agree to. "Won't pay for the
  damage." "Won't move out early."
- **neverSay** — subjects never to raise or confirm, even if asked directly.
  "Don't mention I've been talking to her sister." "Don't bring up the money."
- **acceptableCompromises** — what they said they'd accept if pushed. This is
  the AI's authority to negotiate. Anything they agreed to in a hypothetical
  ("if he offers half, I'd take that") belongs here.

A refusal to *do* something is a hard limit. A refusal to *discuss* something
is a never-say. Something they'd reluctantly accept is a compromise.

## The rest

- **context** — what happened, with the specifics that would let someone hold
  their ground under pushback.
- **feelings** — how they said they feel, in their words. Empty string if never
  stated. Do not infer feelings from tone.
- **mustSay** — things they explicitly want communicated. Substance, unless
  they gave exact wording, in which case keep it exactly.
- **questionsToAnswer** — what they want to find out.
- **recipientName** — what they call the other person. If never named, use a
  natural stand-in based on the relationship ("your sister", "my landlord").
- **relationship** and **tone** — infer from the transcript; these two are the
  only fields you should infer rather than quote.
`.trim();
}

/**
 * Builds the extraction call's messages: the extraction system prompt plus the
 * whole interview rendered as a single transcript.
 *
 * Rendered as one flattened block rather than replayed as role-tagged
 * messages, because the extraction model is an observer of a finished
 * conversation, not a participant in it — replaying the turns as real
 * user/assistant roles invites it to continue the interview instead of
 * summarising it.
 */
export function buildExtractionMessages(
  request: InterviewRequest,
): Array<{ role: 'system' | 'user'; content: string }> {
  const lines = [`They opened with: ${request.situation.trim()}`];
  for (const turn of request.turns) {
    lines.push(
      turn.role === 'assistant'
        ? `Interviewer asked: ${turn.text.trim()}`
        : `They answered: ${turn.text.trim()}`,
    );
  }
  if (request.userFirstName?.trim()) {
    lines.push(`Their first name is ${request.userFirstName.trim()}.`);
  }

  return [
    { role: 'system', content: buildExtractionInstructions() },
    { role: 'user', content: lines.join('\n\n') },
  ];
}

/**
 * Generous compared to the typed cap, because a spoken transcript is not the
 * same shape: there is no one-question-one-answer rhythm, people trail off and
 * restart, and the model backchannels. Still bounded, since this array is
 * client-supplied and every entry costs tokens at extraction time.
 */
export const MAX_SPOKEN_TURNS = 80;

export const SpokenTranscriptSchema = z.object({
  userFirstName: z.string().max(100).optional(),
  turns: z.array(InterviewTurnSchema).min(1).max(MAX_SPOKEN_TURNS),
});
export type SpokenTranscript = z.infer<typeof SpokenTranscriptSchema>;

/**
 * Extraction messages for a spoken interview.
 *
 * Reuses `buildExtractionInstructions()` unchanged — that prompt is about
 * reading a finished interview and sorting what it finds, which is
 * modality-agnostic. Only the transcript rendering differs, and only because a
 * spoken interview has no separate opening "situation" the way the typed one
 * does; it is turns all the way down.
 */
export function buildSpokenExtractionMessages(
  request: SpokenTranscript,
): Array<{ role: 'system' | 'user'; content: string }> {
  const lines = request.turns.map((turn) =>
    turn.role === 'assistant'
      ? `Interviewer asked: ${turn.text.trim()}`
      : `They said: ${turn.text.trim()}`,
  );
  if (request.userFirstName?.trim()) {
    lines.push(`Their first name is ${request.userFirstName.trim()}.`);
  }

  return [
    { role: 'system', content: buildExtractionInstructions() },
    {
      role: 'user',
      content:
        'This interview was spoken out loud and transcribed, so expect ' +
        'false starts and filler. Read through them.\n\n' +
        lines.join('\n\n'),
    },
  ];
}
