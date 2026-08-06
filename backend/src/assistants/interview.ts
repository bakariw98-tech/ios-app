/**
 * The interview assistant — step 2 of the call flow.
 *
 * Talks to the user alone. Its job is to understand the situation well enough to
 * produce the intent object, then hand off to the delegate assistant when the
 * user signals the recipient has joined.
 */

import { intentJsonSchema } from '../domain/intent.js';
import { MERGE_WINDOW_RULES } from '../domain/mergeWindow.js';
import { SAFETY_PROMPT_RULES } from '../domain/safety.js';
import {
  ARTIFACT_PLAN,
  VOICE_INTERVIEW,
  realtimeModel,
  realtimeVoice,
} from './shared.js';

const SYSTEM_PROMPT = `
You are the interview half of an assistant that helps people say things they find
hard to say. Right now you are talking to the user alone. Nobody else is on the
line yet.

Your job is to understand their situation well enough that you could speak for
them — and then to actually hand over to the half of you that does the speaking.

## How to conduct this

Be warm and unhurried. The person calling you is doing something that takes
nerve. Let them get it out however it comes out — sideways, out of order, with
long pauses. Do not rush them toward structure.

Ask about one thing at a time. Short questions. Let silence do some work; people
say the real thing in the second sentence, not the first.

You need to come away knowing:

- their first name, and what they call the recipient
- their relationship
- what actually happened, in their framing
- how they feel about it
- **what specifically they want said** — this is the heart of it, push gently
  until it's concrete
- what they're hoping happens
- anything they want said close to word-for-word
- **anything that must not be raised** — ask this outright, every time, even if
  they haven't hinted at it. "Is there anything you'd rather I didn't bring up?"
- anything they want to know the answer to

## Things not to do

- Don't give advice. You are not their therapist and you are not their friend
  with opinions. If they ask what you think they should do, turn it back: "What
  would you want them to understand?"
- Don't editorialise the situation back at them or reframe it more kindly than
  they told it. Their framing is the one you'll be carrying.
- Don't judge the recipient, even if invited to. You are about to speak to that
  person.
- Don't promise an outcome. You can promise to say it well.

## Reflecting back

Before handing off, say the plan back in three or four sentences — what you'll
say, what you'll leave alone — and ask if you've got it right. People often
correct one important thing at this exact moment. Take the correction.

${MERGE_WINDOW_RULES}

## What happens next

You will not be part of the conversation after the handoff. Everything you know
that matters has to be in the intent object. Anything the user told you in
confidence that isn't needed to deliver the message should stay with you.

${SAFETY_PROMPT_RULES}
`.trim();

export function interviewAssistant(serverUrl: string) {
  return {
    name: 'delegation-interview',
    firstMessage:
      "Hi — I'm here to help you say something that's hard to say. " +
      "Take your time. What's going on?",
    firstMessageMode: 'assistant-speaks-first' as const,

    model: realtimeModel(SYSTEM_PROMPT, 0.7),
    voice: realtimeVoice(VOICE_INTERVIEW),
    // No transcriber field — OpenAI Realtime processes audio in and out
    // natively and does its own transcription; a separate transcriber is for
    // Vapi's traditional (non-realtime) pipeline. See the doc comment on
    // REALTIME_MODEL in shared.ts for how setting one anyway broke real
    // calls silently instead of erroring.
    artifactPlan: ARTIFACT_PLAN,

    // Long enough for someone to work up to it, bounded so a forgotten call
    // doesn't run forever.
    maxDurationSeconds: 1800,
    silenceTimeoutSeconds: 60,

    server: { url: serverUrl },
    serverMessages: [
      'status-update',
      'transcript',
      'tool-calls',
      'end-of-call-report',
    ],

    tools: [
      {
        type: 'handoff' as const,
        function: {
          name: 'begin_delegation',
          description:
            'Hand off to the delegate assistant, which immediately introduces ' +
            'itself to the recipient. Call this the instant you hear a voice ' +
            'that is not the user, or the user says the recipient has joined, ' +
            'or you are simply unsure whether someone new is on the line. ' +
            'When in doubt, call it.',
        },
        destinations: [
          {
            type: 'assistant' as const,
            assistantName: 'delegation-delegate',
            description: 'The recipient has joined; deliver the message.',

            // Deliberately NOT `all`. The delegate works from the structured
            // intent, not from the full emotional transcript of the interview —
            // a third party is listening now. See ADR-002.
            contextEngineeringPlan: { type: 'none' as const },

            // This is what makes the intent object a native Vapi feature.
            variableExtractionPlan: { schema: intentJsonSchema() },
          },
        ],
      },
      {
        type: 'function' as const,
        function: {
          name: 'arm_for_merge',
          description:
            'Call as soon as you begin coaching the user through adding the ' +
            'recipient. Enters the merge window, after which you may only ' +
            'discuss the merge steps or hand off — never the situation.',
          parameters: {
            type: 'object',
            properties: {
              userFirstName: {
                type: 'string',
                description:
                  "The user's first name. Required so the introduction can " +
                  'be prepared before the recipient arrives.',
              },
            },
            required: ['userFirstName'],
          },
        },
        server: { url: serverUrl },
      },
      {
        type: 'function' as const,
        function: {
          name: 'cancel_merge',
          description:
            'Call if the user backs out of adding the recipient. Leaves the ' +
            'merge window and resumes the normal interview.',
          parameters: { type: 'object', properties: {} },
        },
        server: { url: serverUrl },
      },
      {
        type: 'function' as const,
        function: {
          name: 'flag_blocked_situation',
          description:
            'Call when the situation falls into a hard-blocked category. ' +
            'Returns the exact words to say. Say them verbatim and end the call.',
          parameters: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                enum: [
                  'domestic_violence',
                  'minor',
                  'debt_collection',
                  'legal_counterparty',
                ],
              },
              reasoning: {
                type: 'string',
                description: 'Briefly, what in the conversation led here.',
              },
            },
            required: ['category', 'reasoning'],
          },
        },
        server: { url: serverUrl },
      },
    ],
  };
}
