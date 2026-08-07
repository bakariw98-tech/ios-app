/**
 * The conversation intent — the artifact that drives an emotionally difficult
 * conversation.
 *
 * ## The one principle this whole module exists to enforce: goal, not script
 *
 * This is NOT "the user writes a sentence and the AI says it." That is
 * text-to-speech, it has existed for decades, and it is not what this is.
 * What this object captures is a *destination* and the *terrain* around it:
 * where the user is trying to get to, what actually happened, how much room
 * there is to move, and which walls are load-bearing. The AI then negotiates
 * toward that destination live, adapting to whatever the other person
 * actually says — see `domain/liveConversation.ts`.
 *
 * That principle has a concrete consequence for this schema's shape, and it
 * is the main reason this file exists alongside `domain/intent.ts` rather
 * than extending it: that object's core payload is `pointsToConvey` —
 * "the specific things the user wants communicated" — with a delegate prompt
 * that ends "you have nothing to say beyond what is written above." That is a
 * relay. A relay cannot negotiate, because it has no representation of what
 * it would be willing to trade. This object's core payload is `goal`, and the
 * fields that make negotiation possible at all (`acceptableCompromises`,
 * `hardLimits`) have no equivalent there.
 *
 * ## Why three different kinds of limit, not one
 *
 * The live conversation constantly faces one question: *the other person just
 * proposed/asked/said X — now what?* Answering it needs three genuinely
 * different checks, which is why they are three fields and not one list:
 *
 *   - `acceptableCompromises` — things the AI may agree to on the user's
 *     behalf, unprompted. This is the negotiating room. Without it the AI can
 *     only ever restate the opening position or escalate, which is what makes
 *     a relay feel robotic in a real disagreement.
 *   - `hardLimits` — positions the AI must never concede, no matter how
 *     reasonable the other person makes them sound. About *outcomes*.
 *   - `neverSay` — subjects the AI must never raise, confirm, or be drawn
 *     into. About *disclosure*. Distinct from hardLimits: "I won't agree to
 *     split the deposit" is a position; "don't tell her I've been talking to
 *     her sister" is a secret. Conflating them loses one or the other.
 *
 * ## Channel-independent on purpose
 *
 * Nothing here knows about telephony, WebRTC, Twilio, or Vapi. The same
 * intent object drives an in-person session or a phone call; those are output
 * channels that consume this, not shapers of it.
 */

import { z } from 'zod';

/**
 * Shapes tone and what counts as normal to raise — a boundary with a parent
 * lands differently from the same boundary with a landlord. Not a permission
 * check; safety screening (`domain/safety.ts`) is separate and unchanged.
 *
 * Covers the relationships in the target scenarios: friend fallout, family
 * boundary, roommate, landlord, ex, boss/coworker, reconnection after silence.
 */
export const RelationshipSchema = z.enum([
  'family',
  'partner',
  'ex_partner',
  'friend',
  'roommate',
  'coworker',
  'boss',
  'landlord',
  'acquaintance',
  'other',
]);
export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * Deliberately the four registers that fit a hard interpersonal conversation.
 * No `celebratory` (that lives in the transactional//phone Intent) — nothing in
 * the target situations is a celebration, and offering it as an option invites
 * the extraction model to mislabel relief or hope as celebration.
 */
export const ToneSchema = z.enum(['warm', 'neutral', 'firm', 'apologetic']);
export type Tone = z.infer<typeof ToneSchema>;

export const ConversationIntentSchema = z.object({
  userFirstName: z
    .string()
    .min(1)
    .describe("The user's first name, as they gave it."),

  recipientName: z
    .string()
    .min(1)
    .describe('What the user calls the other person — first name or nickname.'),

  relationship: RelationshipSchema.describe(
    'The relationship between the user and the other person.',
  ),

  /**
   * The north star. Everything the AI says in the live conversation is in
   * service of this, and every judgement call resolves by asking "does this
   * move us toward the goal without crossing a limit?"
   */
  goal: z
    .string()
    .min(1)
    .describe(
      'What success looks like at the END of this conversation — the state ' +
        'of the world the user wants to walk away with, not the words they ' +
        'want said. Concrete enough that you could tell afterwards whether ' +
        'it happened.',
    ),

  /**
   * Backstory. Not a script — the raw material the AI draws on to represent
   * the user accurately when the other person disputes, misremembers, or asks
   * something the user never thought to prepare for.
   */
  context: z
    .string()
    .min(1)
    .describe(
      "What actually happened, in the user's own framing, with enough " +
        'specifics (who did what, when, what was said) that the AI can ' +
        'represent it accurately under pushback. Never editorialised, ' +
        'diagnosed, or reframed more kindly than the user told it.',
    ),

  /**
   * Carried so the AI can *report* feeling accurately, never *perform* it.
   * In these situations how the user feels is often part of the message, not
   * colour around it.
   */
  feelings: z
    .string()
    .describe(
      'How the user says they feel about the situation, in their own words ' +
        'where possible. Empty string if they never said.',
    ),

  /**
   * Things that must be communicated by the end. Not a verbatim script —
   * substance the conversation is not complete without.
   */
  mustSay: z
    .array(z.string())
    .describe(
      'Things the user explicitly wants communicated before this is over. ' +
        'Substance, not exact wording — unless the user gave exact wording, ' +
        'in which case keep theirs. Empty array if none.',
    ),

  /**
   * Disclosure limits. Absolute, and they beat the goal.
   */
  neverSay: z
    .array(z.string())
    .describe(
      'Subjects, facts, or phrasings the AI must never raise, confirm, or ' +
        'be drawn into — even if asked directly, even if it would help reach ' +
        'the goal. Empty array if none.',
    ),

  /**
   * The negotiating room. This is what separates this engine from a relay:
   * the AI may offer or accept these live, without stopping to ask.
   */
  acceptableCompromises: z
    .array(z.string())
    .describe(
      'Things the user is willing to accept, offer, or concede if the other ' +
        'person pushes back — the room the AI has to negotiate in without ' +
        'checking back. Empty array if the user gave no room.',
    ),

  /**
   * Positions, not subjects. The other end of the axis from compromises.
   */
  hardLimits: z
    .array(z.string())
    .describe(
      'Outcomes or concessions the AI must never agree to on the user\'s ' +
        'behalf, however reasonable the other person makes them sound. ' +
        'About positions, not secrets (that is neverSay). Empty array if none.',
    ),

  questionsToAnswer: z
    .array(z.string())
    .describe(
      'Things the user wants to know by the end of this conversation. The ' +
        'AI should get these answered in the flow of the conversation, not ' +
        'as an interrogation. Empty array if none.',
    ),

  tone: ToneSchema.describe('The register the user wants struck.'),
});

export type ConversationIntent = z.infer<typeof ConversationIntentSchema>;

/**
 * Hand-written rather than derived from the zod schema via `z.toJSONSchema`.
 *
 * Same reasoning as `inPersonIntake.ts`'s `INTAKE_REPLY_JSON_SCHEMA`: OpenAI's
 * strict Structured Outputs mode requires `additionalProperties: false` and
 * every property listed in `required`, which zod's emitter does not guarantee
 * it produces. Kept in sync with `ConversationIntentSchema` by a drift-guard
 * test rather than by generation, so editing one without the other fails
 * loudly in CI instead of silently 400-ing against a live model.
 *
 * Note there are no nullable fields and no optionals: under strict mode every
 * property must be required, so "the user didn't mention this" is expressed as
 * an empty array or empty string, never a missing key. The interview prompt
 * says so explicitly.
 */
export const CONVERSATION_INTENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    userFirstName: { type: 'string' },
    recipientName: { type: 'string' },
    relationship: {
      type: 'string',
      enum: [
        'family',
        'partner',
        'ex_partner',
        'friend',
        'roommate',
        'coworker',
        'boss',
        'landlord',
        'acquaintance',
        'other',
      ],
    },
    goal: { type: 'string' },
    context: { type: 'string' },
    feelings: { type: 'string' },
    mustSay: { type: 'array', items: { type: 'string' } },
    neverSay: { type: 'array', items: { type: 'string' } },
    acceptableCompromises: { type: 'array', items: { type: 'string' } },
    hardLimits: { type: 'array', items: { type: 'string' } },
    questionsToAnswer: { type: 'array', items: { type: 'string' } },
    tone: { type: 'string', enum: ['warm', 'neutral', 'firm', 'apologetic'] },
  },
  required: [
    'userFirstName',
    'recipientName',
    'relationship',
    'goal',
    'context',
    'feelings',
    'mustSay',
    'neverSay',
    'acceptableCompromises',
    'hardLimits',
    'questionsToAnswer',
    'tone',
  ],
  additionalProperties: false,
} as const;

/**
 * Render the intent into the live conversation's system prompt.
 *
 * Ordering is deliberate and load-bearing in two directions at once. The goal
 * goes FIRST because everything downstream is judged against it and it should
 * frame every other section as it's read. The hard limits go LAST because
 * recency matters in a long system prompt, and of everything here, the limits
 * are what we least want quietly traded away twenty turns into an emotional
 * argument.
 */
export function renderIntentForConversation(intent: ConversationIntent): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none given)';

  const them = intent.recipientName;
  const me = intent.userFirstName;

  return `
## Who you are speaking for

${me} asked you to speak to ${them} (${intent.relationship.replace(/_/g, ' ')})
on their behalf.

## THE GOAL — what you are trying to achieve

${intent.goal}

This is what you are steering toward for the whole conversation. You are not
here to deliver a message and stop; you are here to try to reach this. When
${them} says something you did not expect, the question is always "what does
this mean for reaching the goal, and what do I do next?" — never "what was I
supposed to say?"

## What actually happened

${intent.context}

This is your grounding. Use it to represent ${me} accurately when ${them}
disputes something, misremembers, or asks about a detail. Do not invent
anything beyond it — if ${them} asks something this does not cover, say plainly
that you do not know rather than guessing.

## How ${me} feels

${intent.feelings || '(not stated)'}

Convey this where it helps ${them} understand. Report it — do not perform it.
You are telling someone how another person feels, not feeling it at them.

## Things ${me} wants said before this is over

${list(intent.mustSay)}

Work these in where they land naturally. Do not dump them all at once, and do
not force one in at a moment that would undercut it. If the conversation ends
before you managed one, say so plainly at the end.

## Questions to get answered

${list(intent.questionsToAnswer)}

Ask these in the flow of the conversation, when the moment fits. This is a
conversation, not an interrogation — do not run them as a checklist.

## Room to negotiate — you may offer or accept these WITHOUT asking

${list(intent.acceptableCompromises)}

This is real authority. If ${them} pushes back and the way forward is on this
list, take it — that is what it is for. Stopping to check something already
covered here wastes ${me}'s attention and stalls a conversation that was going
fine.

## Tone

${intent.tone}

## HARD LIMITS — these override the goal itself

Never agree to, on ${me}'s behalf:

${list(intent.hardLimits)}

Never raise, confirm, hint at, or get drawn into:

${list(intent.neverSay)}

These are absolute. If reaching the goal would require crossing one of them,
the limit wins and the goal does not happen — say you are not able to agree to
that, or not able to get into that, and hold it. Do not explain why, do not
negotiate around the edge of it, and do not soften it into a maybe because
${them} is upset or persistent. If ${them} keeps pushing on one, hold it again
in fewer words, not more.
`.trim();
}
