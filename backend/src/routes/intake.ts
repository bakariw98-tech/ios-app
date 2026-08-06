/**
 * The typed intake step. See domain/inPersonIntake.ts for the full design
 * rationale — this route is deliberately thin, mirroring routes/realtime.ts's
 * error-handling shape so the two endpoints behave predictably as a pair.
 */

import type { Hono } from 'hono';

import type { AppBindings } from '../app.js';
import {
  INTAKE_REPLY_JSON_SCHEMA,
  IntakeReplySchema,
  IntakeRequestSchema,
  MAX_INTAKE_QUESTIONS,
  buildFinalizeNudgeMessage,
  buildIntakeMessages,
  clampSituation,
  composeTranscriptSituation,
  normalizeIntakeReply,
} from '../domain/inPersonIntake.js';
import { runStructuredCompletion } from '../lib/openaiChat.js';

export function registerIntakeRoutes(app: Hono<AppBindings>): void {
  app.post('/intake/turn', async (c) => {
    const { openai } = c.get('config');
    // Shares Config.openai with /realtime/session, deliberately: a separate
    // config block would let a deploy offer intake while realtime 503s (or
    // the reverse), and would make /health's `inPerson: Boolean(config.openai)`
    // a lie. One key, one switch, one billing account.
    if (!openai) {
      return c.json({ error: 'in-person mode is not configured' }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    // Validated — and therefore length/count-capped — BEFORE any OpenAI
    // call. This is also the cost guard against an oversized `turns` array:
    // an invalid request never reaches OpenAI, so it never costs anything.
    const parsed = IntakeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid intake request', issues: parsed.error.issues }, 400);
    }
    const request = parsed.data;

    const questionsAsked = request.turns.filter((t) => t.role === 'assistant').length;
    const atCap = questionsAsked >= MAX_INTAKE_QUESTIONS;

    const messages = buildIntakeMessages(request);
    if (atCap) {
      messages.push(buildFinalizeNudgeMessage());
    }

    let content: string;
    try {
      content = await runStructuredCompletion({
        apiKey: openai.apiKey,
        messages,
        schemaName: 'intake_turn',
        jsonSchema: INTAKE_REPLY_JSON_SCHEMA,
      });
    } catch (error) {
      console.error('Failed to run intake turn:', error);
      const detail = error instanceof Error ? error.message : String(error);
      return c.json({ error: 'could not run the intake step', detail }, 502);
    }

    let normalized;
    try {
      const rawParsed: unknown = JSON.parse(content);
      const validated = IntakeReplySchema.safeParse(rawParsed);
      if (!validated.success) {
        throw new Error(`unexpected shape: ${JSON.stringify(validated.error.issues)}`);
      }
      normalized = normalizeIntakeReply(validated.data);
    } catch (error) {
      console.error('Intake model returned an unusable reply:', error);
      const message = error instanceof Error ? error.message : String(error);
      // Truncated, not the full model output verbatim — this is a diagnostic
      // aid, not a place to dump arbitrary (if unlikely) model output into a
      // client-facing response. Key redaction isn't needed here (this text
      // never touches OpenAI's auth), but truncation still is.
      const detail = message.length > 500 ? `${message.slice(0, 500)}…` : message;
      return c.json({ error: 'intake model returned an unusable reply', detail }, 502);
    }

    const situationSoFar = composeTranscriptSituation(request);
    const questionsAskedNow = questionsAsked + (normalized.kind === 'question' ? 1 : 0);

    // At the cap, the route decides — never trust the model to have actually
    // complied with the finalize nudge above. A stubborn `done:false` past
    // the cap becomes `done:true` with the deterministic roll-up, never a
    // fifth question. See composeTranscriptSituation's doc comment.
    if (atCap && normalized.kind === 'question') {
      return c.json({
        done: true,
        question: null,
        situation: situationSoFar,
        situationSoFar,
        questionsAsked,
        questionsRemaining: 0,
      });
    }

    if (normalized.kind === 'done') {
      // The model's own synthesized paragraph, not situationSoFar's mechanical
      // "Asked:/Answered:" roll-up — that roll-up is the fallback for when the
      // model doesn't cooperate (the atCap branch above) or for Skip (which
      // never calls this route at all), not the normal, better-written result
      // of a real intake conversation. clampSituation is still applied so this
      // can never exceed BriefSchema.situation's bound downstream.
      return c.json({
        done: true,
        question: null,
        situation: clampSituation(normalized.situation),
        situationSoFar,
        questionsAsked,
        questionsRemaining: 0,
      });
    }

    return c.json({
      done: false,
      question: normalized.question,
      situation: null,
      situationSoFar,
      questionsAsked: questionsAskedNow,
      questionsRemaining: Math.max(0, MAX_INTAKE_QUESTIONS - questionsAskedNow),
    });
  });
}
