/**
 * The conversation engine's endpoints — the interview loop, and starting the
 * live session it produces.
 *
 * Deliberately separate from `/intake/turn` + `/realtime/session`, which serve
 * the transactional in-person flow (a one-paragraph brief, a delegate that
 * relays it). These two carry the structured `ConversationIntent` instead, and
 * mint a session running the negotiator prompt. Both pairs share `config.openai`
 * and the same error-handling shape, so they behave predictably side by side.
 *
 * Route naming follows the existing convention: thin routes, all the real
 * reasoning in `domain/`, so the engine stays testable without a fetch mock and
 * channel-independent for when telephony picks it back up.
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';
import {
  CONVERSATION_INTENT_JSON_SCHEMA,
  ConversationIntentSchema,
} from '../domain/conversationIntent.js';
import {
  INTERVIEW_REPLY_JSON_SCHEMA,
  InterviewReplySchema,
  InterviewRequestSchema,
  MAX_INTERVIEW_QUESTIONS,
  buildExtractionMessages,
  buildFinalizeNudgeMessage,
  buildInterviewMessages,
  normalizeInterviewReply,
} from '../domain/conversationInterview.js';
import {
  CORRECTION_MARKER_PREFIX,
  CORRECTION_MARKER_SUFFIX,
} from '../domain/inPersonBrief.js';
import { buildLiveConversationInstructions } from '../domain/liveConversation.js';
import { runStructuredCompletion } from '../lib/openaiChat.js';
import { mintEphemeralSession } from '../lib/openaiRealtime.js';

/**
 * The default 400 truncates a twelve-field object with five arrays in it
 * mid-JSON, which surfaces as an unparseable-reply error a long way from the
 * cause. See DEFAULT_MAX_COMPLETION_TOKENS in lib/openaiChat.ts.
 */
const INTENT_MAX_TOKENS = 2000;

const VOICES = ['marin', 'cedar'] as const;
const DEFAULT_VOICE = 'cedar';

export function registerConversationRoutes(app: Hono<AppBindings>): void {
  app.post('/conversation/turn', async (c) => {
    const { openai } = c.get('config');
    if (!openai) {
      return c.json({ error: 'the conversation engine is not configured' }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    // Validated — and therefore length/count-capped — before any OpenAI call,
    // so an oversized request never costs anything.
    const parsed = InterviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid interview request', issues: parsed.error.issues },
        400,
      );
    }
    const request = parsed.data;

    const questionsAsked = request.turns.filter(
      (t) => t.role === 'assistant',
    ).length;
    const atCap = questionsAsked >= MAX_INTERVIEW_QUESTIONS;

    const messages = buildInterviewMessages(request);
    if (atCap) messages.push(buildFinalizeNudgeMessage());

    let reply;
    try {
      const raw = await runStructuredCompletion({
        apiKey: openai.apiKey,
        messages,
        schemaName: 'interview_turn',
        jsonSchema: INTERVIEW_REPLY_JSON_SCHEMA,
      });
      const validated = InterviewReplySchema.safeParse(JSON.parse(raw));
      if (!validated.success) {
        throw new Error(`unexpected shape: ${JSON.stringify(validated.error.issues)}`);
      }
      reply = normalizeInterviewReply(validated.data);
    } catch (error) {
      console.error('Interview turn failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.length > 500 ? `${message.slice(0, 500)}…` : message;
      return c.json({ error: 'could not run the interview turn', detail }, 502);
    }

    // At the cap the route decides, never the model — a stubborn `done:false`
    // becomes an extraction, never an extra question. Same discipline as
    // routes/intake.ts.
    const finished = reply.kind === 'done' || atCap;

    if (!finished) {
      const asked = questionsAsked + 1;
      return c.json({
        done: false,
        question: reply.kind === 'question' ? reply.question : null,
        intent: null,
        questionsAsked: asked,
        questionsRemaining: Math.max(0, MAX_INTERVIEW_QUESTIONS - asked),
      });
    }

    let intent;
    try {
      const raw = await runStructuredCompletion({
        apiKey: openai.apiKey,
        messages: buildExtractionMessages(request),
        schemaName: 'conversation_intent',
        jsonSchema: CONVERSATION_INTENT_JSON_SCHEMA,
        maxCompletionTokens: INTENT_MAX_TOKENS,
      });
      const validated = ConversationIntentSchema.safeParse(JSON.parse(raw));
      if (!validated.success) {
        throw new Error(`unexpected shape: ${JSON.stringify(validated.error.issues)}`);
      }
      intent = validated.data;
    } catch (error) {
      console.error('Intent extraction failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.length > 500 ? `${message.slice(0, 500)}…` : message;
      return c.json({ error: 'could not build the conversation brief', detail }, 502);
    }

    return c.json({
      done: true,
      question: null,
      intent,
      questionsAsked,
      questionsRemaining: 0,
    });
  });

  app.post('/conversation/session', async (c) => {
    const { openai } = c.get('config');
    if (!openai) {
      return c.json({ error: 'the conversation engine is not configured' }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = ConversationIntentSchema.safeParse(
      (body as { intent?: unknown }).intent,
    );
    if (!parsed.success) {
      return c.json(
        { error: 'invalid intent', issues: parsed.error.issues },
        400,
      );
    }

    const requestedVoice =
      typeof (body as { voice?: unknown }).voice === 'string'
        ? (body as { voice: string }).voice
        : undefined;
    const voice = (VOICES as readonly string[]).includes(requestedVoice ?? '')
      ? (requestedVoice as (typeof VOICES)[number])
      : DEFAULT_VOICE;

    // `user_present` because this is the in-person channel: the user is
    // standing there and steers by typed correction rather than by speaking,
    // which many of them cannot reliably do. A phone channel would pass
    // `user_on_line` here and change nothing else.
    const instructions = buildLiveConversationInstructions(parsed.data, {
      escalation: {
        kind: 'user_present',
        correctionMarkerPrefix: CORRECTION_MARKER_PREFIX,
        correctionMarkerSuffix: CORRECTION_MARKER_SUFFIX,
      },
    });

    try {
      const session = await mintEphemeralSession(openai.apiKey, {
        voice,
        instructions,
      });

      return c.json({
        clientSecret: session.clientSecret,
        expiresAt: session.expiresAt,
        model: session.model,
        voice: session.voice,
        // Same reasoning as /realtime/session: clients read the marker format
        // at runtime rather than hardcoding another copy of it.
        correctionMarker: {
          prefix: CORRECTION_MARKER_PREFIX,
          suffix: CORRECTION_MARKER_SUFFIX,
        },
      });
    } catch (error) {
      console.error('Failed to mint a conversation session:', error);
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'could not start the conversation', detail }, 502);
    }
  });
}
