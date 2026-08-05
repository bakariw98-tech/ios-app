/**
 * The delegate assistant — steps 5–7 of the call flow.
 *
 * Speaks to the recipient (with the user still on the line). Its first words are
 * the mandatory disclosure, and the mechanism matters: the disclosure is the
 * `firstMessage` with `firstMessageMode: "assistant-speaks-first"`, which means
 * Vapi speaks it before the model is given a turn.
 *
 * That is the whole point of splitting this from the interview assistant. If the
 * disclosure were an instruction inside a longer prompt, it would be something
 * the model *usually* does. As a firstMessage it is something the model cannot
 * skip, because the model is not consulted.
 *
 * See docs/compliance.md (N1, N2) and docs/technical-decisions.md (ADR-002).
 */

import {
  DISCLOSURE_PROMPT_RULES,
  assertValidDisclosure,
  buildDisclosure,
} from '../domain/disclosure.js';
import { type Intent, renderIntentForPrompt } from '../domain/intent.js';
import {
  TRANSCRIBER,
  VOICE_DELEGATE,
  realtimeModel,
  realtimeVoice,
} from './shared.js';

const CONDUCT_RULES = `
## How to carry the conversation

Once they've agreed to continue, say why you're calling in your own words —
naturally, not as a recital. You are having a conversation, not reading a
statement.

Let them react. They may be surprised, defensive, upset, or relieved. Give them
room for it. Listen more than you talk.

Adapt the order and the wording to how it's going. What you cannot adapt is the
substance: everything you say has to trace back to something in the brief below.
If you notice yourself about to add a detail, a reason, or a reassurance that
isn't there — don't. You'd be making it up on someone else's behalf.

Do not negotiate, concede, apologise for things you weren't asked to apologise
for, or agree to anything on the user's behalf. You are carrying a message, not
holding a mandate. "I'd have to check with them on that" is always available to
you and is always the right answer.

The user is still on the line and can hear all of this. If they interrupt to
correct or add something, follow them — they outrank the brief.

## Ending

Wind up naturally when the message has landed and the questions are answered or
clearly aren't going to be. Thank them for taking the call — mean it. Then end.

If it turns hostile, or they ask you to stop, or they want the user directly:
close it warmly and end. Don't defend, don't push, don't get the last word.
`.trim();

export function delegateAssistant(intent: Intent, serverUrl: string) {
  const disclosure = buildDisclosure(intent.userFirstName);

  // Fails at config-build time rather than on a live call, so a bad refactor
  // can never reach a recipient.
  assertValidDisclosure(disclosure);

  const systemPrompt = [
    'You are speaking on behalf of someone who asked you to say something ' +
      'difficult for them. The recipient is on the line, and so is the user.',
    DISCLOSURE_PROMPT_RULES,
    renderIntentForPrompt(intent),
    CONDUCT_RULES,
  ].join('\n\n');

  return {
    name: 'delegation-delegate',

    // ---- The compliance mechanism. Not configurable. ----
    firstMessage: disclosure,
    firstMessageMode: 'assistant-speaks-first' as const,
    // -----------------------------------------------------

    // Lower than the interview: this half should stay close to the brief rather
    // than find creative phrasings.
    model: realtimeModel(systemPrompt, 0.5),
    voice: realtimeVoice(VOICE_DELEGATE),
    transcriber: TRANSCRIBER,

    maxDurationSeconds: 900,
    silenceTimeoutSeconds: 30,

    server: { url: serverUrl },
    serverMessages: [
      'status-update',
      'transcript',
      'tool-calls',
      'end-of-call-report',
    ],

    // Post-call analysis — ADR-003. This is what produces the user's summary,
    // rather than us running a second pass over the transcript ourselves.
    analysisPlan: {
      summaryPrompt: `
You are writing to ${intent.userFirstName}, who asked an AI assistant to have
this conversation for them and is now waiting to hear how it went.

Write 3–5 sentences, second person, plain and calm. Cover what you said, how
${intent.recipientName} reacted, and anything they asked or committed to. If it
didn't go well, say so gently but do not soften it into something untrue —
they'll know, and they need the real version.

No preamble, no headings. Just tell them how it went.
`.trim(),

      structuredDataPrompt:
        'Extract a factual record of this call against the provided schema. ' +
        'Be strict about the compliance fields — base them on what was ' +
        'actually said, not on what should have happened.',

      structuredDataSchema: {
        type: 'object',
        properties: {
          // --- Compliance audit. See ADR-003. ---
          disclosureDelivered: {
            type: 'boolean',
            description:
              'True only if the assistant identified itself as an AI acting ' +
              'on someone else’s behalf before saying anything substantive.',
          },
          consentObtained: {
            type: 'boolean',
            description:
              'True only if the recipient affirmatively agreed to continue ' +
              'before the message was delivered.',
          },
          // --- What the user is waiting to know. ---
          pointsCommunicated: {
            type: 'array',
            items: { type: 'string' },
            description: 'Which of the intended points actually got said.',
          },
          pointsNotCommunicated: {
            type: 'array',
            items: { type: 'string' },
            description: 'Intended points that did not get said, and why.',
          },
          questionsAnswered: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' },
              },
              required: ['question', 'answer'],
            },
          },
          recipientReaction: {
            type: 'string',
            enum: [
              'receptive',
              'neutral',
              'upset',
              'hostile',
              'declined_to_engage',
            ],
          },
          goalAchieved: {
            type: 'boolean',
            description: 'Whether the user’s desired outcome was reached.',
          },
          boundariesRespected: {
            type: 'boolean',
            description:
              'False if anything on the never-say list was raised, hinted ' +
              'at, or confirmed by the assistant.',
          },
          followUpNeeded: { type: 'string' },
        },
        required: [
          'disclosureDelivered',
          'consentObtained',
          'pointsCommunicated',
          'recipientReaction',
          'goalAchieved',
          'boundariesRespected',
        ],
      },

      successEvaluationPrompt: `
Did this call achieve what ${intent.userFirstName} wanted?

Their stated goal: ${intent.desiredOutcome}

Score 1–10. A call where the message was delivered faithfully and heard is a
success even if ${intent.recipientName} disagreed with it — the user asked to be
heard, not to win. Score low for: the message not landing, boundaries being
crossed, or the assistant improvising beyond the brief.
`.trim(),
      successEvaluationRubric: 'NumericScale' as const,
    },
  };
}
