/**
 * The intent object — step 3 of the call flow.
 *
 * Produced by the interview assistant and carried across the handoff into the
 * delegate assistant. This is the single artifact that defines what the AI is
 * and is not permitted to say to the recipient.
 *
 * It is expressed as a zod schema so the same definition serves three consumers:
 * the Vapi `variableExtractionPlan` (as JSON Schema), the MCP tool contracts,
 * and our own webhook validation.
 */

import { z } from 'zod';

export const RelationshipSchema = z.enum([
  'family',
  'partner',
  'ex_partner',
  'friend',
  'coworker',
  'acquaintance',
  'other',
]);

export const IntentSchema = z.object({
  /** The user's first name, as they gave it. Used to build the disclosure. */
  userFirstName: z
    .string()
    .min(1)
    .describe("The delegating user's first name, as they said it."),

  /** What the recipient should be called. */
  recipientName: z
    .string()
    .min(1)
    .describe('What the user calls the recipient — first name or nickname.'),

  /** Shapes tone, not permission. Out-of-scope relationships are caught by safety screening. */
  relationship: RelationshipSchema.describe(
    'The relationship between the user and the recipient.',
  ),

  /** The situation, in the user's own framing. */
  situation: z
    .string()
    .min(1)
    .describe(
      'What happened, summarised neutrally from what the user described. ' +
        "Keep the user's framing; do not editorialise or diagnose.",
    ),

  /** How the user feels. Carried so the delegate can convey it, not perform it. */
  feelings: z
    .string()
    .describe(
      'How the user says they feel about the situation, in their own words ' +
        'where possible.',
    ),

  /**
   * The core payload. Everything the delegate says traces back to one of these.
   */
  pointsToConvey: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'The specific things the user wants communicated, most important first.',
    ),

  /** What a good outcome looks like. Used for success evaluation. */
  desiredOutcome: z
    .string()
    .min(1)
    .describe('What the user hopes happens as a result of this conversation.'),

  /** Phrases the user explicitly wants said. Verbatim where natural. */
  mustSay: z
    .array(z.string())
    .default([])
    .describe(
      'Things the user explicitly asked to have said, as close to verbatim ' +
        'as the conversation allows.',
    ),

  /** Hard limits. These win over everything, including the desired outcome. */
  neverSay: z
    .array(z.string())
    .default([])
    .describe(
      'Topics, facts, or phrasings the user forbade. Absolute — these ' +
        'override the desired outcome if the two ever conflict.',
    ),

  /** Questions the delegate should try to get answered. */
  questionsToAsk: z
    .array(z.string())
    .default([])
    .describe('Anything the user wants to know the answer to.'),

  /** Tone the user wants struck. */
  tone: z
    .enum(['warm', 'neutral', 'firm', 'apologetic', 'celebratory'])
    .default('warm')
    .describe('The register the user wants the message delivered in.'),
});

export type Intent = z.infer<typeof IntentSchema>;

/**
 * Render the intent into the delegate assistant's system prompt.
 *
 * Deliberately verbose about the boundaries: the ordering here (points, then
 * must-say, then never-say last and loudest) is intentional, because recency
 * matters in a long system prompt and never-say is the constraint we least want
 * ignored.
 */
export function renderIntentForPrompt(intent: Intent): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none given)';

  return `
## Who you are speaking for

${intent.userFirstName} asked you to speak to ${intent.recipientName}
(${intent.relationship.replace(/_/g, ' ')}) on their behalf.

## The situation

${intent.situation}

## How ${intent.userFirstName} feels

${intent.feelings}

Convey this if it helps ${intent.recipientName} understand. Do not perform it —
you are reporting how someone feels, not feeling it.

## What to communicate, most important first

${list(intent.pointsToConvey)}

## What ${intent.userFirstName} hopes comes of this

${intent.desiredOutcome}

## Things to say

${list(intent.mustSay)}

Work these in where they land naturally. If the conversation ends before you
manage it, say so in your closing rather than forcing them in.

## Questions to get answered

${list(intent.questionsToAsk)}

## Tone

${intent.tone}

## Absolute limits — these override everything above

Never raise, confirm, hint at, or be drawn into:

${list(intent.neverSay)}

If ${intent.recipientName} asks directly about something on that list, say you're
not able to get into that, and move on. Do not explain why. Do not improvise
around the edges of it. If following the desired outcome would require crossing
one of these, the limit wins and the outcome does not happen.

You have nothing to say beyond what is written above. If the conversation goes
somewhere this document does not cover, say that you only know what
${intent.userFirstName} asked you to pass on, and offer to have them follow up
directly.
`.trim();
}

/**
 * JSON Schema for Vapi's `variableExtractionPlan`.
 *
 * Vapi evaluates this against the interview before handing off, which is what
 * makes the intent object a native Vapi feature rather than something we
 * assemble ourselves. See docs/technical-decisions.md, ADR-002.
 */
export function intentJsonSchema(): Record<string, unknown> {
  // `io: 'input'` so fields carrying a `.default()` are emitted as optional.
  // The output perspective marks them required, which would push the extraction
  // model to invent values for things the user simply never mentioned — we'd
  // rather it omit them and let the defaults apply.
  return z.toJSONSchema(IntentSchema, {
    target: 'draft-7',
    io: 'input',
  }) as Record<string, unknown>;
}
